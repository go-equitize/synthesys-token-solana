use anchor_lang::prelude::*;

/// All errors mirror EVM custom errors exactly, plus a small number of Solana-specific
/// ones. Auditors can verify 1-to-1 against RWAToken.sol / ZToken.sol / Whitelist.sol /
/// Blocklist.sol.
#[error_code]
pub enum SynthesysTokenError {
    /// Mirrors: error AllTransfersPaused()
    #[msg("All transfers paused")]
    AllTransfersPaused,

    /// Mirrors: error SenderAddressBlocked(address sender)
    #[msg("Sender address blocked")]
    SenderAddressBlocked,

    /// Mirrors: error SenderAddressNotWhitelisted(address sender)
    #[msg("Sender address not whitelisted")]
    SenderAddressNotWhitelisted,

    /// Mirrors: error FromAddressBlocked(address from)
    #[msg("From address blocked")]
    FromAddressBlocked,

    /// Mirrors: error FromAddressNotWhitelisted(address from)
    #[msg("From address not whitelisted")]
    FromAddressNotWhitelisted,

    /// Mirrors: error ToAddressBlocked(address to)
    #[msg("To address blocked")]
    ToAddressBlocked,

    /// Mirrors: error ToAddressNotWhitelisted(address to)
    #[msg("To address not whitelisted")]
    ToAddressNotWhitelisted,

    /// Mirrors: error ZeroAddressAdmin()
    #[msg("Zero address not allowed for admin")]
    ZeroAddressAdmin,

    /// Mirrors: error AccountAlreadyWhitelisted(address account) in Whitelist.sol
    #[msg("Account already whitelisted")]
    AccountAlreadyWhitelisted,

    /// Mirrors: error AccountNotWhitelisted(address account) in Whitelist.sol
    #[msg("Account not whitelisted")]
    AccountNotWhitelisted,

    /// Mirrors: error AccountAlreadyBlocklisted(address account) in Blocklist.sol
    #[msg("Account already blocklisted")]
    AccountAlreadyBlocklisted,

    /// Mirrors: error AccountNotBlocklisted(address account) in Blocklist.sol
    #[msg("Account not blocklisted")]
    AccountNotBlocklisted,

    /// Mirrors: revert ERC20InvalidSender(address(0)) in forceBurn
    #[msg("Invalid account: zero address not allowed")]
    InvalidZeroAddress,

    /// Mirrors: revert ERC20InvalidReceiver(address(0)) in forcedTransfer
    #[msg("Invalid receiver: zero address not allowed")]
    InvalidZeroReceiver,

    /// Caller does not hold the required role.
    /// Mirrors: AccessControl.onlyRole() revert
    #[msg("Unauthorized: missing required role")]
    Unauthorized,

    /// PDA address passed does not match expected derivation.
    #[msg("Invalid account address: PDA mismatch")]
    InvalidAccountAddress,

    /// Token account data too short to read owner field.
    #[msg("Invalid token account data")]
    InvalidTokenAccount,

    /// ExtraAccountMetaList initialization failed.
    #[msg("Failed to initialize extra account meta list")]
    ExtraAccountMetaListError,

    /// Arithmetic overflow in space calculation.
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    /// The supplied token account does not belong to the address being
    /// whitelisted/blocklisted — prevents freezing/thawing the wrong holder's account.
    #[msg("Token account owner does not match the target address")]
    TokenAccountOwnerMismatch,

    /// The mint is not configured for compliance (DefaultAccountState, authorities,
    /// permanent delegate, or transfer hook do not match the expected governance PDA).
    #[msg("Mint is not correctly configured for compliance")]
    InvalidMintConfiguration,

    /// forced_transfer was called with from == to (same token account).
    #[msg("Source and destination token accounts must differ")]
    CannotTransferToSelf,

    /// pre_bridge_send was called before an admin configured the trusted CCIP
    /// router program id via set_ccip_router.
    #[msg("CCIP router program id not configured")]
    CcipRouterNotConfigured,

    /// pre_bridge_send requires a matching post_bridge_restore call later in the
    /// same transaction — none was found before the instruction list ended.
    #[msg("Missing paired post_bridge_restore instruction in this transaction")]
    MissingPostBridgeRestore,

    /// Only ComputeBudget instructions and the configured CCIP router's ccip_send
    /// may appear between pre_bridge_send and post_bridge_restore in the same
    /// transaction — anything else could exploit the window while the hook is off.
    #[msg("Disallowed instruction between pre_bridge_send and post_bridge_restore")]
    DisallowedInstructionInBridgeWindow,

    /// This mint has `whitelist_enabled == true`, but the caller omitted a whitelist PDA
    /// that the instruction requires. When whitelist is enabled the relevant whitelist
    /// account(s) are MANDATORY — passing `None` (or the program id sentinel) for one is
    /// rejected here rather than silently skipping the whitelist check.
    #[msg("Whitelist is enabled for this mint but a required whitelist account was not provided")]
    WhitelistAccountMissing,

    /// A whitelist-management instruction (add_whitelist / remove_whitelist) was called on
    /// a mint whose `whitelist_enabled == false`. Blocklist-only mints have no whitelist to
    /// manage, so these instructions are rejected instead of creating meaningless PDAs.
    #[msg("Whitelist is not enabled for this mint")]
    WhitelistNotEnabled,

    /// revoke_role was called on the last remaining DEFAULT_ADMIN_ROLE or ADMIN_ROLE holder
    /// for this mint. Refused to prevent permanently bricking role administration (no one
    /// left who could grant/revoke roles or administer pause/lists/force-ops).
    #[msg("Cannot revoke the last remaining holder of this role")]
    LastAdminCannotBeRevoked,
}
