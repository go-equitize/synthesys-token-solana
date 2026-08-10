use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    state::{BlocklistEntry, ProgramConfig, RoleEntry, TokenConfig, WhitelistEntry},
};

/// A note on optional whitelist accounts
/// ------------------------------------
/// Every account named `*_whitelist` below is wrapped in `Option<..>`. Whether it is
/// required depends on the mint's immutable `token_config.whitelist_enabled` flag, checked
/// in the handler — NOT here — because Anchor constraints cannot read that flag at
/// account-resolution time. The uniform rule enforced by every handler is:
///   - whitelist_enabled == true  → the account MUST be provided (else `WhitelistAccountMissing`),
///                                   its PDA address is re-derived and verified, and existence
///                                   is checked.
///   - whitelist_enabled == false → the account is ignored entirely.
/// Their PDA addresses are therefore verified manually in the handler (no `seeds` here), so a
/// caller can never substitute a different address's whitelist PDA.
///
/// Blocklist accounts are always mandatory in both modes and keep their normal constraints.

/// Mirrors: function initialize(...) public initializer
/// Creates TokenConfig + 4 RoleEntry PDAs for the admin.
#[derive(Accounts)]
#[instruction(admin: Pubkey, ccip_admin: Pubkey, whitelist_enabled: bool)]
pub struct Initialize<'info> {
    /// Authority whose identity is checked against `program_data.upgrade_authority_address`.
    /// Does not need to fund anything — see `payer`.
    pub authority: Signer<'info>,

    /// Funds the 5 accounts created below. Decoupled from `authority` so the upgrade
    /// authority (which may later be a Squads vault PDA with no SOL balance) never needs
    /// to hold funds itself — any wallet can pay, mirroring how a Safe's `execTransaction`
    /// executor pays gas while the Safe's own balance is untouched.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// Central governance account for this mint.
    #[account(
        init,
        payer = payer,
        space = 8 + TokenConfig::INIT_SPACE,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// ADMIN_ROLE entry for admin — seeds = [ROLE_SEED, mint, ADMIN_ROLE, admin]
    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, admin.as_ref()],
        bump,
    )]
    pub admin_role_entry: Account<'info, RoleEntry>,

    /// MINTER_ROLE entry for admin
    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [ROLE_SEED, mint.key().as_ref(), MINTER_ROLE, admin.as_ref()],
        bump,
    )]
    pub minter_role_entry: Account<'info, RoleEntry>,

    /// BURNER_ROLE entry for admin
    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [ROLE_SEED, mint.key().as_ref(), BURNER_ROLE, admin.as_ref()],
        bump,
    )]
    pub burner_role_entry: Account<'info, RoleEntry>,

    /// DEFAULT_ADMIN_ROLE entry for admin
    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [ROLE_SEED, mint.key().as_ref(), DEFAULT_ADMIN_ROLE, admin.as_ref()],
        bump,
    )]
    pub default_admin_role_entry: Account<'info, RoleEntry>,

    /// CHECK: Authority PDA used as freeze_authority and permanent_delegate on the mint.
    /// Must already be set on the mint before calling initialize.
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    /// This program's ProgramData account. The handler requires
    /// `program_data.upgrade_authority_address == authority` so that only the deployer
    /// (upgrade authority) can initialize — closing the init front-running window.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )]
    pub program_data: Account<'info, ProgramData>,

    /// Optional bootstrap config. When present, the handler also accepts
    /// `program_config.initializer_authority` as `authority` — so onboarding still works
    /// after the upgrade authority is revoked.
    #[account(
        seeds = [PROGRAM_CONFIG_SEED],
        bump = program_config.bump,
    )]
    pub program_config: Option<Account<'info, ProgramConfig>>,

    pub system_program: Program<'info, System>,
}

/// Sets the bootstrapped initializer authority (once). Gated to the current upgrade
/// authority; call before revoking it if not all mints are onboarded yet.
#[derive(Accounts)]
pub struct SetInitializerAuthority<'info> {
    /// Must equal the current program upgrade authority.
    pub authority: Signer<'info>,

    /// Funds creation of `program_config`.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + ProgramConfig::INIT_SPACE,
        seeds = [PROGRAM_CONFIG_SEED],
        bump,
    )]
    pub program_config: Account<'info, ProgramConfig>,

    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

/// Creates the ExtraAccountMetaList PDA required by the Token-2022 transfer hook.
/// Must be called once after initialize() and before any token transfers.
/// Mirrors: no EVM parallel — Solana-specific hook registration.
#[derive(Accounts)]
pub struct InitExtraAccountMetaList<'info> {
    /// ADMIN_ROLE identity check — see `payer` for who funds the account.
    pub authority: Signer<'info>,

    /// Funds creation of `extra_account_meta_list`. Decoupled from `authority` (see
    /// `Initialize` doc comment for rationale).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Caller must hold ADMIN_ROLE.
    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, authority.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Raw account owned by this program; initialized with TLV-encoded
    /// ExtraAccountMetaList by spl_transfer_hook_interface.
    /// Seeds: [b"extra-account-metas", mint] — the standard seed required by
    /// spl-transfer-hook-interface so Token-2022 can locate it.
    #[account(
        mut,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Mirrors: function addWhitelistAccount(address account) public onlyRole(ADMIN)
/// Handler rejects with `WhitelistNotEnabled` if the mint has whitelist disabled.
#[derive(Accounts)]
#[instruction(account: Pubkey)]
pub struct AddWhitelist<'info> {
    /// ADMIN_ROLE identity check — see `payer` for who funds the account.
    pub authority: Signer<'info>,

    /// Funds creation of `whitelist_entry`. Decoupled from `authority`.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, authority.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// The whitelist entry to create. Existence = whitelisted.
    /// Mirrors: _whitelisted[account] = true
    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [WHITELIST_SEED, mint.key().as_ref(), account.as_ref()],
        bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    pub system_program: Program<'info, System>,
}

/// Mirrors: function removeWhitelistAccount(address account) public onlyRole(ADMIN)
/// Handler rejects with `WhitelistNotEnabled` if the mint has whitelist disabled.
#[derive(Accounts)]
#[instruction(account: Pubkey)]
pub struct RemoveWhitelist<'info> {
    /// ADMIN_ROLE identity check — see `payer` for who receives the closed account's rent.
    pub authority: Signer<'info>,

    /// Receives the rent refund from closing `whitelist_entry`. Decoupled from
    /// `authority` — mirrors a Safe executor collecting any gas refund, not the Safe itself.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, authority.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// The whitelist entry to close. Closure = no longer whitelisted.
    /// Mirrors: _whitelisted[account] = false
    #[account(
        mut,
        close = payer,
        seeds = [WHITELIST_SEED, mint.key().as_ref(), account.as_ref()],
        bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    /// CHECK: Authority PDA — used to freeze the account after de-whitelisting.
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    /// The token account to freeze after de-whitelisting (optional in practice;
    /// if not provided, pass any writable account with token::mint = mint — caller
    /// is responsible for calling freeze separately if omitted).
    #[account(
        mut,
        token::mint = mint,
    )]
    pub target_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Mirrors: function addBlocklistAccount(address account) public onlyRole(ADMIN)
/// Also freezes the existing token account to enforce immediately.
#[derive(Accounts)]
#[instruction(account: Pubkey)]
pub struct AddBlocklist<'info> {
    /// ADMIN_ROLE identity check — see `payer` for who funds the account.
    pub authority: Signer<'info>,

    /// Funds creation of `blocklist_entry`. Decoupled from `authority`.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, authority.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// The blocklist entry to create. Existence = blocklisted.
    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [BLOCKLIST_SEED, mint.key().as_ref(), account.as_ref()],
        bump,
    )]
    pub blocklist_entry: Account<'info, BlocklistEntry>,

    /// CHECK: Authority PDA — used to freeze the account.
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    /// Token account to freeze immediately. Must be owned by `account`.
    #[account(
        mut,
        token::mint = mint,
    )]
    pub target_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Mirrors: function removeBlocklistAccount(address account) public onlyRole(ADMIN)
/// Does NOT thaw the account — user calls thaw_account() after removal if still compliant.
#[derive(Accounts)]
#[instruction(account: Pubkey)]
pub struct RemoveBlocklist<'info> {
    /// ADMIN_ROLE identity check — see `payer` for who receives the closed account's rent.
    pub authority: Signer<'info>,

    /// Receives the rent refund from closing `blocklist_entry`. Decoupled from `authority`.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, authority.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// The blocklist entry to close.
    #[account(
        mut,
        close = payer,
        seeds = [BLOCKLIST_SEED, mint.key().as_ref(), account.as_ref()],
        bump,
    )]
    pub blocklist_entry: Account<'info, BlocklistEntry>,
}

/// Mirrors: function mint(address account, uint256 amount) public onlyRole(MINTER_ROLE)
/// Compliance-gated: checks pause, to-blocklist, and — when whitelist_enabled — to-whitelist,
/// then thaws if needed before calling Token-2022 mint_to.
#[derive(Accounts)]
pub struct MintTokens<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// MINTER_ROLE check.
    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), MINTER_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        mut,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Destination token account (must exist; will be thawed if frozen + compliant).
    #[account(
        mut,
        token::mint = mint,
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: OPTIONAL whitelist entry for the recipient's owner — required + must exist
    /// only when whitelist_enabled. Seeds verified in handler.
    pub recipient_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist entry for the recipient's owner — must NOT exist. Always required.
    /// Seeds verified in handler.
    pub recipient_blocklist: UncheckedAccount<'info>,

    /// CHECK: OPTIONAL whitelist PDA for the CALLER (signer). Mirrors the `msg.sender`
    /// branch of `_update`: when the minter is not the recipient and whitelist_enabled, the
    /// minter must itself be whitelisted. Seeds verified in handler.
    pub signer_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for the CALLER (signer) — must NOT exist when caller != recipient.
    #[account(
        seeds = [BLOCKLIST_SEED, mint.key().as_ref(), signer.key().as_ref()],
        bump,
    )]
    pub signer_blocklist: UncheckedAccount<'info>,

    /// CHECK: Authority PDA — used as mint authority and freeze authority.
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Mirrors: function burn(uint256 amount) public onlyRole(BURNER_ROLE)
/// Signer burns from their own token account.
#[derive(Accounts)]
pub struct BurnSelf<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), BURNER_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Signer's own token account.
    #[account(
        mut,
        token::mint = mint,
        token::authority = signer,
    )]
    pub signer_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: OPTIONAL whitelist PDA for the signer (owner) — required + must exist only
    /// when whitelist_enabled. Mirrors EVM `_update` blocklist(from)/whitelist(from). Seeds
    /// verified in handler.
    pub signer_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for the signer (owner) — must NOT exist. Seeds verified by Anchor.
    #[account(
        seeds = [BLOCKLIST_SEED, mint.key().as_ref(), signer.key().as_ref()],
        bump,
    )]
    pub signer_owner_blocklist: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Mirrors: function burn(address account, uint256 amount) public onlyRole(BURNER_ROLE)
/// BURNER_ROLE burns from any compliant account using the permanent delegate PDA.
#[derive(Accounts)]
pub struct BurnAccount<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), BURNER_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Token account to burn from (must be unfrozen — i.e., owner is compliant).
    #[account(
        mut,
        token::mint = mint,
    )]
    pub from_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: OPTIONAL whitelist PDA for the CALLER (signer). Mirrors the `msg.sender`
    /// branch of `_update`: when the burner is not the account owner and whitelist_enabled,
    /// the burner must itself be whitelisted. Seeds verified in handler.
    pub signer_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for the CALLER (signer) — must NOT exist when caller != owner.
    #[account(
        seeds = [BLOCKLIST_SEED, mint.key().as_ref(), signer.key().as_ref()],
        bump,
    )]
    pub signer_blocklist: UncheckedAccount<'info>,

    /// CHECK: OPTIONAL whitelist PDA for the token account OWNER — required + must exist
    /// only when whitelist_enabled. Mirrors EVM blocklist(from)/whitelist(from), independent
    /// of the caller branch above. Seeds verified in handler (owner is an inner account
    /// field, so Anchor `seeds` can't derive it at account-resolution time).
    pub owner_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for the token account OWNER — must NOT exist. Address re-derived
    /// and verified in handler.
    pub owner_blocklist: UncheckedAccount<'info>,

    /// CHECK: Authority PDA — used as permanent delegate for the burn.
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Mirrors: function burnFrom(address account, uint256 amount) public onlyRole(BURNER_ROLE)
/// BURNER_ROLE burns via a user-granted delegation (allowance).
/// The signer must be the approved delegate of from_token_account.
#[derive(Accounts)]
pub struct BurnFrom<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), BURNER_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Token account to burn from. Signer must be an approved delegate.
    /// token::authority = signer validates that signer is owner or delegate.
    #[account(
        mut,
        token::mint = mint,
        token::authority = signer,
    )]
    pub from_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: OPTIONAL whitelist PDA for the CALLER (signer). Mirrors the `msg.sender`
    /// branch of `_update`: when the burner is not the account owner and whitelist_enabled,
    /// the burner must itself be whitelisted. Seeds verified in handler.
    pub signer_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for the CALLER (signer) — must NOT exist when caller != owner.
    #[account(
        seeds = [BLOCKLIST_SEED, mint.key().as_ref(), signer.key().as_ref()],
        bump,
    )]
    pub signer_blocklist: UncheckedAccount<'info>,

    /// CHECK: OPTIONAL whitelist PDA for the token account OWNER — required + must exist
    /// only when whitelist_enabled. Mirrors EVM blocklist(from)/whitelist(from), independent
    /// of the caller branch above. Seeds verified in handler.
    pub owner_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for the token account OWNER — must NOT exist. Address re-derived
    /// and verified in handler.
    pub owner_blocklist: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Mirrors: function forceBurn(address account, uint256 amount) public onlyRole(ADMIN_ROLE)
/// Bypasses pause, whitelist, and blocklist. Uses thaw → burn → re-freeze atomically.
/// No transfer hook is invoked (hook only fires on transfer, not burn).
#[derive(Accounts)]
pub struct ForceBurnTokens<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// ADMIN_ROLE check — mirrors onlyRole(ADMIN_ROLE).
    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Token account to burn from — may be frozen (blocklisted).
    #[account(
        mut,
        token::mint = mint,
    )]
    pub target_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Authority PDA — holds both freeze_authority and permanent_delegate.
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Mirrors: function forcedTransfer(address from, address to, uint256 amount) public onlyRole(ADMIN_ROLE)
/// Bypasses ALL compliance checks including pause. Uses the bypassing_compliance flag
/// so the transfer hook skips its checks (mirrors `super._update()` call on EVM).
#[derive(Accounts)]
pub struct ForcedTransfer<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// ADMIN_ROLE check.
    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        mut,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Source token account — may be frozen.
    #[account(
        mut,
        token::mint = mint,
    )]
    pub from_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Destination token account — may be frozen.
    #[account(
        mut,
        token::mint = mint,
    )]
    pub to_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Authority PDA — freeze_authority + permanent_delegate.
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    /// CHECK: OPTIONAL whitelist PDA for from_token_account.owner — verified in handler
    /// only when whitelist_enabled.
    pub from_owner_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for from_token_account.owner — address verified in handler.
    pub from_owner_blocklist: UncheckedAccount<'info>,

    /// CHECK: OPTIONAL whitelist PDA for to_token_account.owner — verified in handler
    /// only when whitelist_enabled.
    pub to_owner_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for to_token_account.owner — address verified in handler.
    pub to_owner_blocklist: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Mirrors: function pause() public onlyRole(ADMIN_ROLE)
///          function unpause() public onlyRole(ADMIN_ROLE)
#[derive(Accounts)]
pub struct SetPause<'info> {
    pub signer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        mut,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,
}

/// Mirrors: grantRole(bytes32 role, address account)
/// Only DEFAULT_ADMIN_ROLE holder can grant.
#[derive(Accounts)]
#[instruction(role: String, grantee: Pubkey)]
pub struct GrantRole<'info> {
    /// DEFAULT_ADMIN_ROLE identity check — see `payer` for who funds the account.
    pub authority: Signer<'info>,

    /// Funds creation of `role_entry`. Decoupled from `authority`.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Caller must hold DEFAULT_ADMIN_ROLE.
    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), DEFAULT_ADMIN_ROLE, authority.key().as_ref()],
        bump,
    )]
    pub caller_role: Account<'info, RoleEntry>,

    #[account(
        mut,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// The role entry to create. Existence = grantee has role.
    /// seeds are validated inside the handler because role is a runtime string.
    /// CHECK: PDA for [ROLE_SEED, mint, role_bytes, grantee]; verified in handler.
    #[account(mut)]
    pub role_entry: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Mirrors: revokeRole(bytes32 role, address account)
/// Only DEFAULT_ADMIN_ROLE holder can revoke.
#[derive(Accounts)]
#[instruction(role: String, grantee: Pubkey)]
pub struct RevokeRole<'info> {
    /// DEFAULT_ADMIN_ROLE identity check — see `payer` for who receives the closed
    /// account's rent.
    pub authority: Signer<'info>,

    /// Receives the rent refund from closing `role_entry`. Decoupled from `authority`.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), DEFAULT_ADMIN_ROLE, authority.key().as_ref()],
        bump,
    )]
    pub caller_role: Account<'info, RoleEntry>,

    #[account(
        mut,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Role entry to close; verified in handler.
    #[account(mut)]
    pub role_entry: UncheckedAccount<'info>,
}

/// Mirrors: function setCCIPAdmin(address newAdmin) external onlyRole(ADMIN_ROLE)
#[derive(Accounts)]
pub struct SetCCIPAdmin<'info> {
    pub signer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        mut,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,
}

/// Called by Token-2022 via CPI on every transfer.
/// Mirrors: function _update(address from, address to, uint256 value) internal override
///
/// Account order MUST match what `spl_transfer_hook_interface::instruction::execute`
/// produces. The interface places the validation (ExtraAccountMetaList) account at
/// index 4, and the resolved extra accounts begin at index 5:
///   [0] source_token_account
///   [1] mint
///   [2] destination_token_account
///   [3] authority (owner or delegate)
///   [4] extra_account_meta_list (validation account — fixed by the interface)
///   [5] token_config        (extra #0 — static PDA)
///   [6] from_whitelist       (extra #1 — PDA from source_token_account.owner)
///   [7] from_blocklist       (extra #2 — PDA from source_token_account.owner)
///   [8] to_whitelist         (extra #3 — PDA from destination_token_account.owner)
///   [9] to_blocklist         (extra #4 — PDA from destination_token_account.owner)
///  [10] authority_whitelist  (extra #5 — PDA from authority.key)
///  [11] authority_blocklist  (extra #6 — PDA from authority.key)
///
/// The whitelist accounts are ALWAYS resolved and passed (fixed layout), but the handler
/// only reads them when `token_config.whitelist_enabled == true`. All whitelist/blocklist
/// PDA addresses are re-derived and verified inside the handler against the owners read
/// from the token-account data, so a caller cannot substitute a different address's
/// compliance PDAs.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: Source token account — validated by Token-2022 before calling hook.
    pub source_token_account: UncheckedAccount<'info>,

    /// CHECK: Mint — validated by Token-2022.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Destination token account — validated by Token-2022.
    pub destination_token_account: UncheckedAccount<'info>,

    /// CHECK: Transfer authority (owner or approved delegate).
    pub authority: UncheckedAccount<'info>,

    /// CHECK: ExtraAccountMetaList validation account — index 4 is fixed by the
    /// spl-transfer-hook-interface Execute layout. Not read by our handler; declared
    /// so the resolved extra accounts below land at their correct indices.
    #[account(
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    // ---- Extra accounts from ExtraAccountMetaList ----

    /// Pause state, bypass flag, and whitelist_enabled mode.
    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// CHECK: Whitelist PDA for the source-account owner; verified/read only when whitelist_enabled.
    pub from_whitelist: UncheckedAccount<'info>,

    /// CHECK: Blocklist PDA for the source-account owner; address + existence verified in handler.
    pub from_blocklist: UncheckedAccount<'info>,

    /// CHECK: Whitelist PDA for the destination-account owner; verified/read only when whitelist_enabled.
    pub to_whitelist: UncheckedAccount<'info>,

    /// CHECK: Blocklist PDA for the destination-account owner; address + existence verified in handler.
    pub to_blocklist: UncheckedAccount<'info>,

    /// CHECK: Whitelist PDA for the authority (caller/delegate); verified/read only when whitelist_enabled.
    pub authority_whitelist: UncheckedAccount<'info>,

    /// CHECK: Blocklist PDA for the authority (caller/delegate); verified in handler.
    pub authority_blocklist: UncheckedAccount<'info>,
}

/// No EVM parallel — Solana-specific step required because
/// DefaultAccountState=Frozen means new accounts start frozen.
///
/// Anyone can call this for any token account, but it only succeeds if
/// the token account's owner is NOT blocklisted and — when whitelist_enabled — whitelisted.
#[derive(Accounts)]
pub struct ThawTokenAccount<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// Token account to thaw.
    #[account(
        mut,
        token::mint = mint,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: OPTIONAL whitelist PDA for token_account.owner — required + must exist only
    /// when whitelist_enabled. Seeds verified in handler.
    pub owner_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for token_account.owner — must NOT exist. Always required.
    /// Seeds verified in handler.
    pub owner_blocklist: UncheckedAccount<'info>,

    /// CHECK: Authority PDA — used as freeze_authority to thaw.
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Transfers the mint authority from our authority_pda to a new address — generic,
/// accepts any Pubkey (a plain wallet, a native SPL Multisig containing the CCIP pool
/// signer PDA, or a Squads vault PDA).
///
/// Required once during CCIP pool setup because the authority_pda is a
/// program-owned PDA — regular wallets can't sign a SetAuthority for it.
/// This instruction signs on behalf of the PDA.
#[derive(Accounts)]
pub struct TransferMintAuthority<'info> {
    pub signer: Signer<'info>,

    /// ADMIN_ROLE check.
    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// CHECK: Authority PDA — current mint authority (will sign SetAuthority CPI).
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Two-step mint-authority handoff — step 1 (propose). ADMIN_ROLE records a candidate in
/// `token_config.pending_mint_authority`; authority_pda keeps MintTokens until the
/// candidate accepts. Complements the one-step `transfer_mint_authority` for destinations
/// that can sign an accept.
#[derive(Accounts)]
pub struct ProposeMintAuthority<'info> {
    pub signer: Signer<'info>,

    /// ADMIN_ROLE check.
    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        mut,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,
}

/// Two-step mint-authority handoff — step 2 (accept). The pending candidate signs to claim
/// MintTokens; authority_pda signs the SetAuthority CPI moving it to the candidate. No
/// ADMIN_ROLE account — the gate is that the signer equals the proposed candidate.
#[derive(Accounts)]
pub struct AcceptMintAuthority<'info> {
    /// Must equal `token_config.pending_mint_authority`.
    pub candidate: Signer<'info>,

    #[account(
        mut,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// CHECK: Authority PDA — current mint authority (will sign SetAuthority CPI).
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Mirrors SetCCIPAdmin's pattern — ADMIN_ROLE sets the trusted CCIP router program
/// id used by pre_bridge_send to validate the bridge-send instruction window.
#[derive(Accounts)]
pub struct SetCCIPRouter<'info> {
    pub signer: Signer<'info>,

    #[account(
        seeds = [ROLE_SEED, mint.key().as_ref(), ADMIN_ROLE, signer.key().as_ref()],
        bump,
    )]
    pub role_entry: Account<'info, RoleEntry>,

    #[account(
        mut,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,
}

/// Opens a compliance-checked window during which the transfer hook is disabled so
/// the deployed CCIP router (which cannot forward hook extra-accounts — see
/// deployed router's onramp CPI carries only the 4 base accounts, so it cannot resolve
/// this mint's ExtraAccountMetaList — see bridge.rs) can move the signer's tokens into
/// pool custody. Permissionless — gated on the SAME compliance checks the hook
/// itself performs on the caller, not on ADMIN_ROLE.
///
/// Must be paired with a `post_bridge_restore` call later in the SAME transaction,
/// with nothing but ComputeBudget instructions and the configured router's
/// `ccip_send` in between — enforced via the Instructions sysvar in the handler, so
/// the hook can never be left disabled and the window can't be used to sandwich an
/// unrelated transfer/mint.
#[derive(Accounts)]
pub struct PreBridgeSend<'info> {
    pub signer: Signer<'info>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: OPTIONAL whitelist PDA for the signer — required + must exist only when
    /// whitelist_enabled. Seeds verified in handler.
    pub signer_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for the signer — must NOT exist. Seeds verified by Anchor.
    #[account(
        seeds = [BLOCKLIST_SEED, mint.key().as_ref(), signer.key().as_ref()],
        bump,
    )]
    pub signer_blocklist: UncheckedAccount<'info>,

    /// CHECK: Authority PDA — signs the Token-2022 transfer_hook_update CPI.
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    /// The token account the sandwiched `ccip_send` will debit. `pre_bridge_send` has no
    /// way to see which account(s) the router's opaque CPI actually touches, so the only
    /// sound gate is requiring the signer to BE its owner (enforced in the handler) —
    /// closing the window to delegate-initiated bridging entirely.
    #[account(
        token::mint = mint,
    )]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Instructions sysvar — used to verify post_bridge_restore is paired
    /// later in this same transaction with no disallowed instructions in between.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Closes the window opened by `pre_bridge_send`, restoring the transfer hook.
/// No compliance gate needed — re-enabling the hook only restores enforcement, so
/// it's always safe to call.
#[derive(Accounts)]
pub struct PostBridgeRestore<'info> {
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// CHECK: Authority PDA — signs the Token-2022 transfer_hook_update CPI.
    #[account(
        seeds = [AUTHORITY_SEED, mint.key().as_ref()],
        bump = token_config.authority_bump,
    )]
    pub authority_pda: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Optional compliance wrapper around Token-2022 approve.
/// Mirrors: function _approve(owner, spender, value, emitEvent) internal override
///
/// NOTE: Users CAN call Token-2022 approve directly, bypassing this wrapper.
/// The transfer hook mitigates this by checking the delegate (authority) at
/// transfer time — an uncompliant delegate cannot transfer.
#[derive(Accounts)]
pub struct ApproveTokens<'info> {
    pub signer: Signer<'info>,

    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// Owner's token account. signer must be the owner.
    #[account(
        mut,
        token::mint = mint,
        token::authority = signer,
    )]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: OPTIONAL whitelist PDA for the OWNER (signer). Mirrors `_approve`, which
    /// checks the owner's compliance as well as the spender's, when whitelist_enabled.
    /// Seeds verified in handler.
    pub owner_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Blocklist PDA for the OWNER (signer) — must NOT exist. Seeds verified by Anchor.
    #[account(
        seeds = [BLOCKLIST_SEED, mint.key().as_ref(), signer.key().as_ref()],
        bump,
    )]
    pub owner_blocklist: UncheckedAccount<'info>,

    /// CHECK: OPTIONAL whitelist PDA for the delegate — required + must exist only when
    /// whitelist_enabled. Seeds verified in handler.
    pub delegate_whitelist: Option<UncheckedAccount<'info>>,

    /// CHECK: Delegate blocklist — must be empty. Address verified in handler.
    pub delegate_blocklist: UncheckedAccount<'info>,

    /// The delegate to approve.
    /// CHECK: Just a pubkey receiving approval rights.
    pub delegate: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
