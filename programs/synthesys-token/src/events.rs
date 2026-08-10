use anchor_lang::prelude::*;

/// Mirrors: event TokenMinted(address indexed to, uint256 amount)
#[event]
pub struct TokenMinted {
    pub to: Pubkey,
    pub amount: u64,
}

/// Mirrors: event TokenBurned(address indexed from, uint256 amount)
/// Emitted by burn(uint256) and burn(address,uint256).
/// `from` is the owner; `from_token_account` disambiguates when the owner holds
/// multiple token accounts for this mint.
#[event]
pub struct TokenBurned {
    pub from: Pubkey,
    pub from_token_account: Pubkey,
    pub amount: u64,
}

/// Mirrors: event ForceBurn(address indexed account, uint256 amount)
/// `account` is the owner; `token_account` is the specific account burned.
#[event]
pub struct ForceBurn {
    pub account: Pubkey,
    pub token_account: Pubkey,
    pub amount: u64,
}

/// Mirrors: event TokenForcedTransferred(address indexed from, address indexed to, uint256 amount)
/// `from`/`to` are owners; the `*_token_account` fields identify the moved accounts.
#[event]
pub struct TokenForcedTransferred {
    pub from: Pubkey,
    pub to: Pubkey,
    pub from_token_account: Pubkey,
    pub to_token_account: Pubkey,
    pub amount: u64,
}

/// Mirrors: event CCIPAdminTransferred(address indexed previousAdmin, address indexed newAdmin)
#[event]
pub struct CCIPAdminTransferred {
    pub previous_admin: Pubkey,
    pub new_admin: Pubkey,
}

/// Mirrors: event AddressWhitelisted(address indexed account) in IWhitelist
#[event]
pub struct AddressWhitelisted {
    pub account: Pubkey,
}

/// Mirrors: event AddressRemovedFromWhitelist(address indexed account) in IWhitelist
#[event]
pub struct AddressRemovedFromWhitelist {
    pub account: Pubkey,
}

/// Mirrors: event AddressBlocklisted(address indexed account) in IBlocklist
#[event]
pub struct AddressBlocklisted {
    pub account: Pubkey,
}

/// Mirrors: event AddressRemovedFromBlocklist(address indexed account) in IBlocklist
#[event]
pub struct AddressRemovedFromBlocklist {
    pub account: Pubkey,
}

/// Emitted when a role is granted.
/// Mirrors: AccessControl.RoleGranted(bytes32 role, address account, address sender)
#[event]
pub struct RoleGranted {
    pub role: String,
    pub account: Pubkey,
    pub sender: Pubkey,
}

/// Emitted when a role is revoked.
/// Mirrors: AccessControl.RoleRevoked(bytes32 role, address account, address sender)
#[event]
pub struct RoleRevoked {
    pub role: String,
    pub account: Pubkey,
    pub sender: Pubkey,
}

/// Emitted on successful initialize().
/// `whitelist_enabled` records the immutable per-mint compliance mode chosen at init.
#[event]
pub struct TokenInitialized {
    pub mint: Pubkey,
    pub admin: Pubkey,
    pub ccip_admin: Pubkey,
    pub whitelist_enabled: bool,
}

/// Mirrors: Paused(address account) from PausableUpgradeable
#[event]
pub struct Paused {
    pub account: Pubkey,
}

/// Mirrors: Unpaused(address account) from PausableUpgradeable
#[event]
pub struct Unpaused {
    pub account: Pubkey,
}

/// Emitted when a user thaws their own token account via thaw_account().
/// No EVM parallel — Solana-specific account activation step.
#[event]
pub struct AccountThawed {
    pub token_account: Pubkey,
    pub owner: Pubkey,
}

/// Emitted when the trusted CCIP router program id is updated via set_ccip_router.
#[event]
pub struct CCIPRouterUpdated {
    pub previous_router: Pubkey,
    pub new_router: Pubkey,
}

/// Emitted when pre_bridge_send opens a compliant bridge-send window (hook disabled).
#[event]
pub struct BridgeSendOpened {
    pub signer: Pubkey,
}

/// Emitted when post_bridge_restore closes the window (hook restored).
#[event]
pub struct BridgeSendClosed {}

/// Emitted when transfer_mint_authority (one-step) or accept_mint_authority (two-step)
/// hands the mint authority off from authority_pda. Makes an otherwise-irreversible
/// handoff observable for post-hoc verification.
#[event]
pub struct MintAuthorityTransferred {
    pub mint: Pubkey,
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted when propose_mint_authority nominates a candidate for the two-step handoff.
/// The authority does not move until the candidate calls accept_mint_authority.
#[event]
pub struct MintAuthorityProposed {
    pub mint: Pubkey,
    pub candidate: Pubkey,
}
