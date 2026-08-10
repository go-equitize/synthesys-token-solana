use anchor_lang::prelude::*;

/// Central governance account for one token mint.
///
/// EVM parallel:
///   paused              ← PausableUpgradeable internal `_paused`
///   ccip_admin          ← s_ccipAdmin
///   default_admin       ← holder of DEFAULT_ADMIN_ROLE (can grant/revoke roles)
///   bypassing_compliance← internal flag set atomically during forcedTransfer so the
///                         transfer hook skips checks (mirrors super._update() bypass)
///   whitelist_enabled   ← no EVM parallel. Chosen ONCE at initialize() and never mutated
///                         afterwards (no instruction writes to it after init), so it is a
///                         structural, immutable per-mint property — not a runtime toggle.
///
/// Seeds: [TOKEN_CONFIG_SEED, mint]
#[account]
#[derive(InitSpace)]
pub struct TokenConfig {
    /// The Token-2022 mint this config governs.
    pub mint: Pubkey,
    /// Global pause flag — mirrors PausableUpgradeable.paused().
    pub paused: bool,
    /// CCIP admin — mirrors s_ccipAdmin (read/written via set_ccip_admin,
    /// emitting CCIPAdminTransferred, exactly like EVM).
    ///
    /// SOLANA SEMANTICS: unlike EVM — where CCIP's RegistryModuleOwnerCustom calls
    /// `getCCIPAdmin()` to discover the token admin — CCIP on Solana does NOT read this
    /// field. The operative CCIP admin is the CCIP **Token Admin Registry** administrator,
    /// established by the mint authority via the starter-kit tutorial:
    /// `svm:admin:propose-administrator` → `svm:admin:accept-admin-role`. Keep this value
    /// equal to that registry administrator so on-chain state and CCIP agree.
    pub ccip_admin: Pubkey,
    /// Holder of DEFAULT_ADMIN_ROLE (can grant / revoke all roles).
    pub default_admin: Pubkey,
    /// Set to `true` only for the duration of a `forced_transfer` instruction
    /// so the transfer hook skips all compliance checks (mirrors `super._update()`).
    /// Cleared before the instruction returns; safe because Solana is single-threaded.
    pub bypassing_compliance: bool,
    /// Whether whitelist enforcement is active for this mint.
    ///
    /// Set exactly once, at `initialize()`, from the `whitelist_enabled` argument, and
    /// NEVER written again by any instruction — there is deliberately no setter. This makes
    /// "is this mint whitelisted?" an immutable, structurally-guaranteed property that no
    /// admin key can flip after the fact:
    ///   - `true`  → behaves like rwa-token: every compliance path requires the relevant
    ///               address to be whitelisted (and not blocklisted). All whitelist PDAs
    ///               become MANDATORY for the whitelisted-gated instructions — omitting one
    ///               reverts with `WhitelistAccountMissing`.
    ///   - `false` → behaves like z-token: blocklist-only. Whitelist PDAs are optional and
    ///               ignored; whitelist-management instructions (add/remove) are rejected
    ///               with `WhitelistNotEnabled`.
    pub whitelist_enabled: bool,
    /// Canonical bump for this PDA.
    pub bump: u8,
    /// Canonical bump for the authority PDA (freeze authority + permanent delegate).
    pub authority_bump: u8,
    /// The CCIP router program id trusted by `pre_bridge_send` to validate the
    /// bridge-send instruction window (see instructions::bridge). Unset
    /// (Pubkey::default()) until an admin calls set_ccip_router.
    pub ccip_router_program_id: Pubkey,
    /// Number of live DEFAULT_ADMIN_ROLE holders for this mint. Maintained by
    /// grant_role/revoke_role; revoke_role refuses to drop this below 1 so role
    /// membership can never be permanently bricked (no one left who can grant/revoke).
    pub default_admin_count: u32,
    /// Number of live ADMIN_ROLE holders for this mint. Same last-holder guard as
    /// `default_admin_count`, since losing every ADMIN_ROLE holder would similarly brick
    /// pause/list/force-ops/CCIP-config administration (recoverable only by a
    /// DEFAULT_ADMIN_ROLE re-grant, but better prevented outright).
    pub admin_count: u32,
    /// Pending mint-authority candidate for the optional two-step handoff
    /// (`propose_mint_authority` → `accept_mint_authority`). `Some(candidate)` after an
    /// ADMIN proposes; cleared to `None` once the candidate accepts. `authority_pda` keeps
    /// MintTokens for the whole interval, so a mistyped destination is recoverable (just
    /// re-propose) until the real recipient confirms by signing. The one-step
    /// `transfer_mint_authority` remains for PDA pool signers that cannot sign an accept.
    pub pending_mint_authority: Option<Pubkey>,
}

/// Program-global bootstrap config (singleton PDA, seeds [PROGRAM_CONFIG_SEED]).
///
/// `initializer_authority` may be set once by the program upgrade authority before it is
/// revoked, letting `initialize()` accept that key as an alternative to the (possibly
/// revoked) upgrade authority — so onboarding future mints survives an "immutable program"
/// revocation.
#[account]
#[derive(InitSpace)]
pub struct ProgramConfig {
    /// Authority permitted to call initialize() alongside the upgrade authority.
    pub initializer_authority: Pubkey,
    /// Canonical bump for this PDA.
    pub bump: u8,
}

/// Whitelist entry for one address on one mint.
///
/// EVM parallel: `mapping(address => bool) _whitelisted` in Whitelist.sol
/// Existence of this PDA = the address is whitelisted.
/// Absence = not whitelisted.
///
/// Only meaningful when `token_config.whitelist_enabled == true`.
///
/// Seeds: [WHITELIST_SEED, mint, address]
#[account]
pub struct WhitelistEntry {}

/// Blocklist entry for one address on one mint.
///
/// EVM parallel: `mapping(address => bool) _blocklisted` in Blocklist.sol
/// Existence = blocklisted; absence = not blocklisted.
///
/// Seeds: [BLOCKLIST_SEED, mint, address]
#[account]
pub struct BlocklistEntry {}

/// Role assignment entry: records that `address` holds `role` for `mint`.
///
/// EVM parallel: AccessControlUpgradeable._roles[role][account] = true
/// Existence = has the role; absence = does not.
///
/// Seeds: [ROLE_SEED, mint, role_bytes, address]
///   where role_bytes is one of: ADMIN_ROLE | MINTER_ROLE | BURNER_ROLE | DEFAULT_ADMIN_ROLE
#[account]
pub struct RoleEntry {}
