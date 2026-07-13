# Synthesys Token

A single Solana program for **compliant, permissioned tokens** on **Token-2022**, bridgeable to
Ethereum with **Chainlink CCIP**. It unifies two compliance postures into one binary, chosen **per
mint** at creation and **fixed for the life of the mint**:

- **Whitelisted mint** (`whitelist_enabled = true`) — an allow-list token: an address must be
  **whitelisted** (and not blocklisted) to hold or move tokens. For real-world-asset / security
  tokens where every holder is KYC'd.
- **Blocklist-only mint** (`whitelist_enabled = false`) — a deny-list token: anyone can hold and
  transfer **unless** they've been blocklisted. A lighter-touch compliance posture (USDC/USDT-style).

Both share the same code, roles, force-ops, pause, and CCIP wiring — the only difference is whether
the whitelist is enforced, and that choice is made once and cannot be changed later.

> **Status:** builds clean (`anchor build`), full dual-mode test suite passing on localnet (62
> tests across nine spec files). **Not yet deployed to a public cluster.** The whitelist-switch
> surface has not been through the security audit that covered its predecessor programs — treat as
> pre-audit. See `docs/DESIGN-DOC.md` for the full design, compromises, and trust assumptions.

Program ID (dev keypair): `7rCrfZnJakWfGfUmHovVGWFvwxnELfxnXzebmatjXeHp` — regenerate for your own
deployment.

---

## The per-mint whitelist switch

`initialize(admin, ccip_admin, whitelist_enabled)` records `whitelist_enabled` in the mint's config
account **and there is no instruction that can ever change it again** — no setter exists in the
program. So a mint is permanently whitelisted or permanently blocklist-only. This makes "is this
token whitelisted?" a structural, un-flippable property rather than something an admin key can toggle
mid-life.

Because one binary serves both, whitelist accounts are **optional** on the compliance-gated
instructions, with a fail-closed rule enforced on-chain:

- **Whitelisted mint** → the whitelist account is **mandatory**; omitting it reverts with
  `WhitelistAccountMissing`. Its address is re-derived and verified, and the owner must actually be
  whitelisted.
- **Blocklist-only mint** → the whitelist account is **ignored** (pass `null`), and
  `add_whitelist` / `remove_whitelist` are rejected with `WhitelistNotEnabled`.

Blocklist enforcement is identical in both modes.

---

## What the code actually does

A normal SPL token is a free-for-all. This program turns a Token-2022 mint into a **governed** token
where transfers, mints, and burns respect a compliance policy, and where an admin can freeze, seize,
or force-move funds when regulation requires it. Three ideas do most of the work:

1. **Accounts start frozen.** The mint uses `DefaultAccountState = Frozen`, so a new token account is
   inert until the program thaws it — and it only thaws accounts whose owner passes the compliance
   check (whitelisted / not blocklisted, per mode). This is the primary gate.

2. **A transfer hook vets every transfer.** Token-2022 calls into the program on every transfer. The
   hook enforces pause and per-owner compliance on the source owner, destination owner, and any
   third-party delegate — so a stale approval to a delegate who later becomes non-compliant can't be
   exercised.

3. **One program-owned authority holds the powerful keys.** A single PDA (`authority`, derived from
   the mint) is the mint's freeze authority, permanent delegate, and — initially — mint authority. It
   has no private key; it acts only when the program's role checks allow. "Who can freeze/seize/mint"
   collapses to "who holds the right on-chain role."

### Token-2022 extensions in play

| Extension | Purpose |
|---|---|
| `DefaultAccountState = Frozen` | New accounts are inert until the program thaws a compliant owner. |
| `TransferHook → this program` | Lets the program vet every transfer (pause + per-owner compliance). |
| `PermanentDelegate → authority PDA` | Lets the program force-burn / force-move any account. |
| `FreezeAuthority → authority PDA` | Lets the program freeze/thaw to enforce compliance state. |
| `MintAuthority → authority PDA` | Program mints; later handed to a delegated authority (e.g. a Squads vault or an SPL Multisig co-signed by the CCIP pool signer) once bridging is wired. |

Compliance lists aren't separate contracts — **membership is just the existence of a small PDA**
(whitelist / blocklist / role) inside the program. Nothing to swap, no external calls in the hot path.

---

## Roles

Access control mirrors OpenZeppelin's `AccessControl`. Each role is a pubkey checked against the
transaction signer, so a role can be held by a wallet **or** a multisig (e.g. a Squads vault) with no
code changes.

| Role | Can do |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Grant / revoke any role. |
| `ADMIN_ROLE` | Manage whitelist/blocklist, pause, force-burn, force-transfer, CCIP + mint-authority setup. |
| `MINTER_ROLE` | Mint. |
| `BURNER_ROLE` | Burn. |

`initialize` bootstraps one admin key with all four roles; split them later by granting narrower
roles. The admin key(s) are fully trusted — they can pause, freeze, and move any balance.

`token_config` tracks live counts of `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE` holders, and
`revoke_role` refuses to drop either below one — so role administration can never be permanently
bricked by revoking the last admin.

---

## Compliance in practice

- **Mint / burn** re-check pause + compliance directly (transfer hooks don't fire on mint/burn).
- **`force_burn` / `forced_transfer`** intentionally bypass **all** compliance (pause, blocklist,
  whitelist, freeze) and are **ADMIN-only** — the regulatory "seize / relocate" tools.
  `forced_transfer` moves value as burn-from + mint-to of equal amount (a literal transfer would make
  Token-2022 re-enter this program through the hook, which Solana disallows).
- **Blocklisting re-freezes immediately** — funds become inert on the spot.
- **Removing a blocklist entry doesn't auto-thaw** — the account must be thawed again.

Main instructions: `initialize`, `initialize_extra_account_meta_list`, `add/remove_whitelist`
(whitelisted mints only), `add/remove_blocklist`, `mint`, `burn_self/account/from`, `force_burn`,
`forced_transfer`, `pause/unpause`, `grant/revoke_role`, `transfer_mint_authority`,
`thaw_token_account`, `approve_tokens`, `set_ccip_admin`, `set_ccip_router`, `pre_bridge_send`,
`post_bridge_restore`, and the transfer-hook `fallback`.

---

## Cross-chain bridging (Chainlink CCIP)

The token bridges between an EVM deployment and Solana using CCIP as pure transport — CCIP's router
and burn-mint token pool (separately deployed and audited by Chainlink) own all routing and
rate-limiting; this program just provides a compliant Token-2022 mint. Bridging is **burn-and-mint**
in both directions.

```
EVM → Solana:  burn on EVM    → CCIP attests → pool mints to the Solana recipient
Solana → EVM:  burn on Solana → CCIP attests → pool mints to the EVM recipient
```

**The transfer-hook wrinkle.** The deployed CCIP router can't carry the extra accounts a Token-2022
transfer hook needs, so a naive outbound send fails. The program solves this with `pre_bridge_send`
and `post_bridge_restore`, which wrap the CCIP send in a **single atomic transaction**: the hook is
switched off just for the router's burn and switched back on in the same transaction, so it can never
be left disabled. `pre_bridge_send` still enforces pause + compliance on the caller (whitelist too,
on whitelisted mints), requires the caller to own the declared source account, and rejects the
transaction unless the paired restore — and nothing else unexpected — is present. Freeze-state
compliance stays enforced throughout.

For a whitelisted mint, inbound recipients must be whitelisted first (delivery mint honors the
allow-list), or the delivery mint reverts on the destination.

Once bridging is fully wired, mint authority is handed off to a delegated authority co-signed by the
CCIP pool signer (via `transfer_mint_authority`), so **the program can no longer mint locally** — new
tokens appear on Solana only by bridging in from EVM.

---

## Build & test

```bash
anchor build                      # build the program; regenerates target/idl + types/SynthesysToken.*

# Run the test suite against a local validator (program must be deployed UPGRADEABLE, because
# `initialize` requires program_data.upgrade_authority == signer):
solana-test-validator --reset &
solana program deploy -u localhost \
  --program-id target/deploy/synthesys_token-keypair.json \
  target/deploy/synthesys_token.so
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
  yarn test          # runs tests/synthesys-token/*.spec.ts via ts-mocha
```

The suite lives in `tests/synthesys-token/` — nine spec files (`01-config-lists` … `09-bridge`)
sharing `fixtures.ts`. It stands up two mints — whitelist enabled and disabled — and exercises every
instruction against both, with heavy focus on the pass/omit-whitelist-PDA matrix, `transfer_checked`
through the hook, and the admin-only + full-bypass guarantees for `forced_transfer` / `force_burn`.

### Dependencies
- `anchor-lang` / `anchor-spl` `0.31.1` (Token-2022 + associated-token features)
- `spl-tlv-account-resolution` / `spl-transfer-hook-interface` `0.6.3`
- Release builds: `overflow-checks = true`, `lto = "fat"`, `codegen-units = 1`.

---

## Repo layout (standalone)

```
programs/synthesys-token/     the program (lib.rs, context.rs, state.rs, instructions/, …)
tests/synthesys-token/        dual-mode test suite (nine *.spec.ts files + fixtures.ts)
scripts/svm/synthesys-token/  numbered deploy/operate flow (1_create-mint … 8_bridge-send)
scripts/svm/{token,pool,router,admin}/  CCIP router + burn-mint pool tooling
scripts/evm/                  EVM-side rwa-token / z-token / router scripts
docs/                         guides and runbooks (DESIGN-DOC, bridge runbooks, audit reports)
docs/DESIGN-DOC.md            full design, compromises, trust assumptions
```

The `syn:*` npm scripts in `package.json` wrap the numbered Solana flow
(`syn:create-mint`, `syn:initialize`, `syn:set-ccip-router`, `syn:whitelist`, `syn:thaw`, `syn:mint`,
`syn:handoff-to-pool`, `syn:bridge-send`); `svm:pool:*` / `svm:router:*` / `svm:token:*` wrap the
CCIP pool and router setup.

---

## Security & trust (read `docs/DESIGN-DOC.md`)

This program mirrors the EVM contracts' **powerful, centralized admin** model, not a trust-minimized
one: `ADMIN_ROLE` can pause, freeze, seize (`force_burn`), and force-move (`forced_transfer`) any
funds; `MINTER_ROLE` is uncapped; the **program upgrade authority outranks everything** — including
the whitelist-mode immutability guarantee — and is the true root of trust. Hold `ADMIN_ROLE`,
`DEFAULT_ADMIN_ROLE`, and the upgrade authority in a multisig + timelock. CCIP's programs are a
separate trusted system. See `docs/DESIGN-DOC.md` §10 for the complete list.
