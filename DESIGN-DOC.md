# Design Doc — Synthesys Token (Solana / Token-2022)

## 1. Purpose

`synthesys-token` brings EVM-style compliant-token controls (mint/burn, role-gated admin,
force-transfer, pause, address-list enforcement) onto Solana, built on **Token-2022** extensions,
with each mint bridgeable to an EVM twin via **Chainlink CCIP**.


| | `whitelist_enabled = true` | `whitelist_enabled = false` |
|---|---|---|
| Compliance model | Allow-list **+** deny-list (whitelist AND blocklist) | Deny-list only (blocklist) |
| Behavioural analogue | the audited `rwa-token` / EVM `RWAToken.sol` — Reg D/S-style fully permissioned security token | the audited `z-token` / EVM `ZToken.sol` — open circulating token with a blacklist (USDC/USDT-style) |
| Whitelist PDAs | **mandatory** on every compliance-gated instruction | optional and **ignored** |
| `add_whitelist` / `remove_whitelist` | allowed | rejected (`WhitelistNotEnabled`) |

Everything else — mint extensions, role infrastructure, CCIP wiring, the atomic bridge-send
workaround (`bridge.rs`), the force-ops, pause — is identical across both modes.


## 2. Feature parity with EVM

The per-transfer semantics trace 1:1 to the audited EVM contracts, selected by mode: a whitelisted
mint reproduces `RWAToken.sol`; a blocklist-only mint reproduces `ZToken.sol`.

| Feature | EVM implementation | Synthesys Token (Solana) |
|---|---|---|
| Roles / access control | OZ `AccessControl`, role constants as bytes32 | PDA registry keyed `[ROLE_SEED, mint, ROLE, signer]`; `ADMIN_ROLE`, `MINTER_ROLE`, `BURNER_ROLE`, `DEFAULT_ADMIN_ROLE` |
| Mint / burn | `_mint` / `_burn` | `mint`, `burn_self`, `burn_account`, `burn_from` |
| Compliance force-ops | `forceTransfer`, `forceBurn` | `forced_transfer`, `force_burn` — bypass the transfer hook via a `bypassing_compliance` flag (§6) |
| Pause | OZ `Pausable` modifier | App-level `token_config.paused` flag, checked in the hook and privileged instructions |
| Allow-list enforcement | `mapping(address => bool)` in `_update` | whitelist PDA existence — **only when `whitelist_enabled`** |
| Deny-list enforcement | `mapping(address => bool)` in `_update` | blocklist PDA existence — **always** |
| Cross-chain bridging | Native ERC20 + CCIP token pool | Token-2022 mint + CCIP Solana router + burn/mint pool wiring |
| Outbound bridge send | plain `ccipSend` (ERC20 has no transfer hook) | `pre_bridge_send` / `post_bridge_restore` atomic sandwich around `ccip_send` (§4.1) |
| CCIP router binding | implicit (pool holds the router address) | `set_ccip_router` stores the router program id on `token_config.ccip_router_program_id`; the bridge sandwich allows only that exact program's `ccip_send` in its window |

### 2.1 Feature summary (what the program exposes)

- **Lifecycle:** `initialize` (chooses the immutable `whitelist_enabled` mode),
  `initialize_extra_account_meta_list` (creates the hook's `ExtraAccountMetaList`).
- **Supply:** `mint` (MINTER), `burn_self` / `burn_account` / `burn_from` (BURNER).
- **Compliance lists:** `add_whitelist` / `remove_whitelist` (rejected on blocklist-only mints),
  `add_blocklist` / `remove_blocklist`; membership = PDA existence; blocklisting re-freezes the
  target immediately.
- **Account activation:** `thaw_token_account` (permissionless, succeeds only if the owner is
  compliant for that mint's mode).
- **Regulatory overrides (ADMIN):** `force_burn`, `forced_transfer` — bypass all compliance by
  design (§6).
- **Pause:** `pause` / `unpause` (app-level flag).
- **Roles:** `grant_role` / `revoke_role` (DEFAULT_ADMIN), four fixed roles, multisig-agnostic (§5).
- **Delegation:** `approve_tokens` (compliance-gated wrapper over Token-2022 `approve`).
- **Mint authority:** `transfer_mint_authority` (generic — hands off to a wallet, Squads vault, or
  the CCIP pool signer).
- **Bridging:** `set_ccip_router`, `pre_bridge_send`, `post_bridge_restore`, and the ADMIN-only
  `update_transfer_hook_program` (manual/emergency hook toggle).
- **Transfer hook:** `fallback` (`Execute`) — the Token-2022 transfer-hook entry point.

## 3. Token-2022 extensions used (identical for both modes)

- `DefaultAccountState = Frozen`
- `TransferHook` → program's own ID
- `PermanentDelegate` → `authority_pda`
- `FreezeAuthority` / `MintAuthority` → `authority_pda`

`initialize` fails closed (`InvalidMintConfiguration`) unless all of the above are set on the mint
before it is called. Not used: `MetadataPointer` (no on-chain name/symbol/logo — §4.4), and no
native `Pausable` extension (pause is hand-rolled, §4.3).

## 4. Solana-specific limitations and the compromises implemented

### 4.1 CCIP router cannot forward Token-2022 transfer-hook accounts

**Gap:** Chainlink's deployed Solana CCIP router builds its onramp `transfer_checked` CPI with a
hardcoded 4-account list. A Token-2022 mint with an active `TransferHook` extension always fails
outbound `ccip_send` with "account required by the instruction is missing" — the failure happens
inside the router before the pool is invoked, so there is no ALT trick or custom-pool workaround.

**Compromise implemented — the `bridge.rs` atomic sandwich (`pre_bridge_send` /
`post_bridge_restore`).** The naive fix (toggle the hook off, send, toggle on across three
transactions) leaves the hook mint-wide off between transactions, during which *any* transfer skips
hook checks. Instead the program forces the whole thing into **one atomic transaction**:

```
[ pre_bridge_send , (ComputeBudget…) , router.ccip_send , post_bridge_restore ]
```

- `pre_bridge_send` first re-runs the caller's compliance exactly as the hook's authority branch
  would (pause + blocklist, **and whitelist when the mint has `whitelist_enabled`**), requires the
  caller to own the declared `source_token_account`
  (`require_keys_eq!(source_token_account.owner, signer)`, else `TokenAccountOwnerMismatch`, 6019),
  then **introspects the transaction via the Instructions sysvar**: it walks forward from its own
  index and requires that a paired `post_bridge_restore` for the same mint appears later in the
  *same* transaction, with **nothing between them except ComputeBudget instructions and the
  configured router's exact `ccip_send`** (matched by `token_config.ccip_router_program_id` + the
  `ccip_send` discriminator). Only then does it CPI `transfer_hook_update` to unset the hook.
- `post_bridge_restore` re-enables the hook; it needs no gate.

**Why this closes the window:** Solana transaction atomicity. A lone `pre_bridge_send` with no
paired restore reverts the entire transaction, including the toggle (`MissingPostBridgeRestore`,
6023). The strict instruction allowlist stops an attacker sandwiching an unrelated transfer/mint
into the disabled-hook window (`DisallowedInstructionInBridgeWindow`, 6024).

**Residual compromise vs EVM (accepted).** `pre_bridge_send` compliance-checks the *caller* and
binds the caller to a `source_token_account` they own, but it cannot see which account the opaque
router `ccip_send` CPI will actually debit. Fully closing that would mean doing the transfer
in-program instead of delegating to CCIP's CPI. The owner check closes the demonstrated
delegate-exploit path (a compliant delegate riding a still-valid approval to move a blocklisted
owner's funds); see the sibling programs' `bridge-window-*` history.


**Two operational (not program-level) CCIP gotchas that block a send if wired wrong:**
- The registered pool ALT must contain only the pool's canonical accounts; padding it with the
  router's own writable accounts makes the router reject the send (`InvalidInputsLookupTableAccountWritable`).
- Inbound (EVM → Solana) recipients must be provisioned compliant first (§4.6).

### 4.2 New token accounts start frozen — an onboarding step EVM doesn't need

**Gap:** `DefaultAccountState = Frozen` means every freshly created ATA is frozen at creation, one
layer below any compliance-list check. This holds in **both modes**.

**Compromise implemented:** `thaw_token_account` is **permissionless** but only succeeds if the
target owner clears that mint's compliance gate, and the mint is not paused:
- `whitelist_enabled = true`: owner must hold a whitelist PDA **and** must not hold a blocklist PDA.
- `whitelist_enabled = false`: owner must not hold a blocklist PDA (no whitelist requirement).

**Impact:** onboarding a new holder is a two-step sequence (get compliance-cleared, then thaw) with
no EVM equivalent. This is the cost of using `DefaultAccountState` to guarantee no token account is
transactable before compliance is checked at least once — and it applies to blocklist-only mints
too, which is a difference from a plain SPL token.

### 4.3 Pause is application-level, not a Token-2022 extension

**Gap:** Token-2022 has no native pause primitive.

**Compromise implemented:** a plain `token_config.paused` boolean, checked in the transfer hook
(before any owner/authority check) and in privileged instructions (`mint`, `thaw_token_account`,
`update_transfer_hook_program`, `pre_bridge_send`, etc.).

**Impact:** functionally equivalent to EVM's `Pausable`, but only as strong as every code path that
checks it — and it depends on §4.1's toggle: `update_transfer_hook_program` refuses to run while
paused so pause can't be defeated by disabling the hook.

### 4.4 No on-chain metadata

**Gap:** no `MetadataPointer` extension — name/symbol/logo aren't on the mint.

**Impact:** minor — affects wallet/explorer display only, not compliance or transfer logic.

### 4.5 The compliance model is a per-mint runtime property, not a compile-time one

The two predecessor programs encoded "whitelist or not" as **two separate binaries**.
`synthesys-token` encodes it as `token_config.whitelist_enabled`, chosen at `initialize` and never
mutated (§5). The compliance *semantics* per mode are unchanged from the audited programs:

- `whitelist_enabled = true` (`require_compliant` with whitelist): every transfer checks blocklist
  first, then whitelist, on from-owner, to-owner, and third-party authority — full permissioned
  model, mirroring `rwa-token`.
- `whitelist_enabled = false` (`require_compliant` with the whitelist branch skipped): only the
  deny-list check on the same three parties — mirroring `z-token`.

The trade-off this introduces (a single fixed hook account layout for both modes) is in §4.7.

### 4.6 Inbound bridge delivery must land on an already-compliant recipient

**Gap:** CCIP's inbound mint (`mint_to`, crediting a Solana recipient) is signed by the pool as mint
authority and **does not run this program's `mint` handler or the transfer hook** — Token-2022 fires
hooks on transfer only. So the compliance gate on a bridged-in recipient is *only* their
frozen/thawed state.

**Compromise implemented:** the recipient must be made compliant **before** the message is
delivered — whitelisted (whitelisted mint) or non-blocklisted (blocklist-only mint) and holding a
thawed ATA. If not, the mint CPI fails and CCIP marks the message "failed on destination"
(re-executable), rather than reverting the source burn.

**Impact:** bridging is not "fire and forget" for a whitelisted mint — provisioning the destination
address is a prerequisite on the receiving chain.

### 4.7 Blocklist-only mints still resolve the full whitelist hook-account set (deliberate)

**Divergence from `z-token` (accepted trade-off).** `z-token` registers **4** transfer-hook extra
accounts (`token_config` + from/to/authority blocklist), specifically to reduce per-transfer
compute. `synthesys-token` **always registers the full 7** (`token_config` + from/to/authority ×
whitelist+blocklist), regardless of `whitelist_enabled` (`NUM_EXTRA_ACCOUNT_METAS = 7`).

**Why:** a single, fixed `Execute` account layout means one hook code path and one
`ExtraAccountMetaList` builder, with no per-mint index branching — removing a whole class of
"wrong account at index N" bugs that a mode-dependent layout would invite. On a blocklist-only mint
Token-2022 still resolves the two whitelist PDAs per participant, but the hook **never reads them**
(the whitelist branch of `require_compliant` is skipped when `whitelist_enabled == false`).

**Impact:** a `whitelist_enabled = false` mint costs the same per-transfer account resolution as a
whitelisted one (≈2 extra resolved accounts vs `z-token`), i.e. higher CU and a slightly larger
hook-account footprint than `z-token` for the same compliance posture. This is a compute/robustness
trade, not a correctness or security difference — the ignored accounts cannot affect the outcome.

## 5. The immutable per-mint whitelist switch

This is the defining addition over the predecessor programs.

**Mechanism.** `initialize(admin, ccip_admin, whitelist_enabled)` writes `whitelist_enabled` into
`token_config`. **No other instruction ever writes that field — there is deliberately no setter.**
Because Solana account data can only change through instructions the program defines, the absence of
any writer makes the mode *structurally* immutable: it is not merely "no admin exposed," it is "no
code path exists." A mint is therefore permanently either whitelisted or blocklist-only.

**Why immutable rather than a toggle.** For a permissioned/RWA mint, "is this token whitelisted?"
is a compliance property that must not be silently flippable by an admin key mid-life (flip off →
move funds that should have been blocked → flip on). Baking it in at creation removes that as a
governance/attack surface entirely and makes it auditable from a single `initialize` call.

**Optional whitelist accounts + fail-closed enforcement.** Because one binary serves both modes,
every whitelist account on the compliance-gated instructions (`mint`, `thaw_token_account`,
`approve_tokens`, `burn_account`, `burn_from`, `forced_transfer`, `pre_bridge_send`) is an
`Option<UncheckedAccount>`. The uniform rule, enforced in-handler by `util::enforce_whitelist`:

- `whitelist_enabled == true` → the whitelist account is **mandatory**. If the caller omits it, the
  instruction reverts with **`WhitelistAccountMissing`** (6025) — it never silently skips the check.
  When present, its PDA address is re-derived and verified, and existence (= whitelisted) is
  required.
- `whitelist_enabled == false` → the whitelist account is **ignored** entirely (pass `None`).

Blocklist accounts are always mandatory in both modes. `add_whitelist` / `remove_whitelist` are
rejected on a blocklist-only mint with **`WhitelistNotEnabled`** (6026), so no meaningless whitelist
PDAs can be created. (Because a blocklist-only mint can never hold a whitelist entry,
`remove_whitelist` there is in practice unreachable — Anchor's `close` constraint rejects the
non-existent account first.)

**`forced_transfer` interaction (important):** when `whitelist_enabled`, the from/to owner whitelist
accounts must still be **passed** (else `WhitelistAccountMissing`) but their existence is **not**
checked — a forced transfer must be able to move funds out of a non-whitelisted / blocklisted /
frozen account (clawback). See §6.

## 6. Compliance force-ops (ADMIN-only, full bypass)

`force_burn` and `forced_transfer` are the regulatory "seize / relocate" tools and, by design,
**bypass every compliance check** — pause, blocklist, whitelist, and freeze state — and are callable
**only by an `ADMIN_ROLE` holder** (the role PDA is seeded on the signer, so a non-admin cannot
satisfy it). Mechanics:

- `force_burn`: thaw (if frozen) → burn via permanent delegate → restore the prior freeze state. The
  transfer hook never fires on burn.
- `forced_transfer`: sets `token_config.bypassing_compliance = true`, thaws both accounts if frozen,
  moves value as **burn-from + mint-to of equal amount** (a literal `transfer_checked` would make
  Token-2022 re-enter this program through the hook, which Solana disallows), restores freeze state,
  then clears the flag. Net supply is unchanged. Rejects `from == to` (`CannotTransferToSelf`).

Whitelist accounts on these instructions are address-validated only, never existence-gated (§5) —
otherwise the bypass would fail on exactly the non-compliant accounts it exists to act on.

**Maintenance hazard (documented, acknowledged):** `bypassing_compliance` is a persisted flag,
currently safe because burn/mint never re-enter the hook; a future `transfer_checked` CPI inside the
window would bypass compliance. Any such change must be reviewed against this.

## 7. Transfer restrictions: three enforcement layers

There is no single choke point like EVM's `_update`. Enforcement is split across three independent
layers, each of which must be individually correct:

1. **Token-2022 core account state (frozen/thawed).** Enforced by SPL Token-2022 before any hook
   runs; the only layer active even when the hook is off (§4.1's window). Controlled via
   `freeze_authority` / `PermanentDelegate` = `authority_pda`.
2. **The `TransferHook` program (this program's compliance logic).** Invoked **only** on
   `Transfer` / `TransferChecked` — never on `MintTo` / `Burn`. So CCIP's inbound bridge mint never
   runs through the hook; a bridged-in recipient's compliance is enforced entirely by the
   frozen-by-default + gated-thaw mechanism (§4.2). The hook checks pause first, then blocklist
   (precedence) and — when `whitelist_enabled` — whitelist, on from-owner, to-owner, and the
   third-party authority.
3. **Per-instruction `require!` checks in each handler.** `mint` / `burn` require `MINTER` /
   `BURNER` and re-check pause + compliance; `forced_transfer` / `force_burn` require `ADMIN` and
   bypass the hook by design; `approve_tokens` checks compliance at approval time.

**Consequence:** "can compliance be bypassed here" must be answered per operation — is it a
`Transfer` (hook runs), a `MintTo` / `Burn` (hook does not run; compliance must be established via
freeze state or explicit `require!`s), or a program-gated force-op (hook explicitly bypassed).

## 8. Inherited audit fixes (from the `rwa-token` / `z-token` audit)

`synthesys-token` was built from the audited sibling code; every fix in `docs/AUDIT_REPORT.md` is
present. Error codes for shared paths are unchanged (the two new errors are appended at 6025/6026),
so cited codes like 6019/6023/6024 remain accurate.

- **Finding 1 (Critical):** full hook enforcement of from-owner, to-owner, delegate per-owner at
  transfer time (owner-derived PDAs via `Seed::AccountData{_, 32, 32}`; addresses re-derived and
  verified; blocklist precedence). Present in `transfer_hook.rs` / `initialize.rs`.
- **Finding 2 (High):** `initialize` gated on `program_data.upgrade_authority_address == signer`.
- **Finding 3 (Medium):** `initialize` validates mint config (authorities, `DefaultAccountState`,
  hook) fail-closed with `InvalidMintConfiguration`.
- **Finding 4 (Medium):** `update_transfer_hook_program` refuses to run while paused.
- **Finding 5 (Medium):** `util::create_managed_pda` (griefable-`create_account` fix) used by
  `grant_role` and `initialize_extra_account_meta_list`.
- **Finding 6 (Mitigated):** `approve_tokens` is an advisory wrapper; direct Token-2022 `approve`
  can't be intercepted, but frozen accounts can't approve and the hook re-checks all parties at
  transfer time.
- **L-1 / L-3 / L-4:** `revoke_role` no-op emits nothing; `forced_transfer` rejects `from == to`;
  `thaw_token_account` is pause-gated.

**Not covered by that audit** (new to this program): §5's optional-account + fail-closed logic,
§4.7's always-full hook list in blocklist-only mode, and the `whitelist_enabled` immutability itself.

## 9. Multisig: Solana vs EVM

Role-based governance is **multisig-agnostic by construction**: `Signer<'info>` only checks
`is_signer`, whether that came from a wallet's ed25519 signature or a program's `invoke_signed` on a
PDA it owns (e.g. a Squads vault). Granting `ADMIN_ROLE` (or any role) to a Squads vault PDA instead
of a wallet needs **no code change** — a member proposes a CPI into the role-gated instruction with
the vault PDA as `authority`; once M-of-N approve, Squads' `execute` signs via `invoke_signed`,
satisfying `Signer<'info>` exactly like a real signature.

To make this work cleanly, every account-creating/closing instruction takes **two** signers:
`authority` (role-checked, may be a vault PDA) and `payer` (funds/receives rent, always a real
wallet — whoever calls Squads' `execute`). This mirrors a Safe's `execTransaction` executor paying
gas while the Safe's balance is untouched. `transfer_mint_authority` stays generic (any Pubkey) so a
native SPL Multisig can still co-sign Token-program authority fields (e.g. `mint_authority` with a
CCIP pool signer) if a deployment needs it.

## 10. Trust assumptions

This program deliberately mirrors the EVM contracts' trust model — powerful, centralized admin
control — not a trust-minimized one.

- **Admin keys are fully trusted.** `ADMIN_ROLE` can pause all transfers, freeze/thaw any account,
  seize funds (`force_burn`), and move funds between any two accounts bypassing every compliance
  check (`forced_transfer`). `DEFAULT_ADMIN_ROLE` can grant any role. The blast radius of a
  compromised admin key is total — hold these roles in a Squads vault (§9), not a hot wallet.
- **`MINTER_ROLE` is unbounded.** No mint cap, rate limit, or multi-party approval — one signature
  mints any `u64` to any compliant recipient.
- **The program upgrade authority outranks every on-chain role.** Whoever can deploy new code to the
  program ID can rewrite mint, pause, force-ops, role checks, the hook — and, critically, the
  `whitelist_enabled` immutability guarantee itself (§5). It is the true root of trust and the only
  way to evolve compliance logic post-deploy. Hold it in a multisig + timelock.
- **The whitelist mode is immutable only under the current binary.** §5's guarantee holds as long as
  the deployed code contains no setter. A program upgrade that adds one would break it — so the
  upgrade authority is, transitively, able to flip a mint's compliance mode. This is the same trust
  boundary as everything else, but worth stating because the immutability is otherwise absolute.
- **CCIP's programs are a separate, trusted system.** The router, burn-mint pool, rate limiting, and
  allowlisting live in Chainlink's separately-deployed, separately-audited programs; this repo
  trusts them and only provides a compliant mint. Once mint authority is handed to the CCIP pool
  signer, that pool can mint on delivery gated only by *its* rules.
- **After the mint-authority handoff, Solana can no longer mint locally — only bridging in mints.**
  The final CCIP setup step moves mint authority from `authority_pda` to the pool signer; from then
  the program's own `mint` fails and new supply on Solana only arrives via inbound cross-chain
  transfer. (A deployment needing both local minting and CCIP must hand authority to a native SPL
  multisig containing both `authority_pda` and the pool signer.)
- **`token_config.ccip_admin` is cosmetic.** It exists for API parity with EVM's `s_ccipAdmin`;
  CCIP on Solana does not read it. The operative CCIP admin is the Token Admin Registry
  administrator, set via CCIP's own two-step flow.
- **Compliance correctness spans three layers, not one choke point (§7).** Any new balance-moving
  instruction must re-establish its own checks; the hook won't cover mint/burn paths.
- **Not yet deployed / unaudited new surface.** Treat program IDs and addresses as non-production.
  The new whitelist-switch surface has not been through the sibling programs' audit (§1, §8).

## 11. Resolved / historical notes

- **`initialize()` hardening vs CCIP bootstrap.** Requiring `mint.mint_authority == authority_pda`
  at initialize time conflicts with CCIP's self-serve pool bootstrap and `propose-administrator`,
  which require the *signer* to be the mint authority. Resolved operationally by **mint-authority
  sequencing**: the mint starts with the wallet as mint authority, all pool + admin-registry setup
  runs under the wallet, and mint authority is handed to the CCIP pool signer only as the final
  step. Ordering matters — handing off before the admin registry is complete permanently bricks the
  mint for CCIP.
- **Lineage.** This program supersedes the two-binary `rwa-token` / `z-token` split for new
  deployments that want a single program; those remain the reference for the audited per-mode
  behaviour.
