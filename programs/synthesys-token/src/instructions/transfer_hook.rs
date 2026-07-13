use anchor_lang::prelude::*;

use crate::{constants::*, context::Execute, error::SynthesysTokenError};

/// Transfer hook — executed by Token-2022 via CPI on EVERY transfer_checked call.
///
/// Mirrors: function _update(address from, address to, uint256 value) internal override
///
/// Full EVM `_update` parity — compliance is enforced here at transfer time, NOT via
/// per-account freeze state (which cannot represent per-owner status when one owner holds
/// multiple token accounts). We check:
///   1. paused()                         → AllTransfersPaused
///   2. from-owner  (source acct owner)  → blocklist (+ whitelist when whitelist_enabled)
///   3. to-owner    (dest acct owner)    → blocklist (+ whitelist when whitelist_enabled)
///   4. authority (msg.sender), only when it is neither the from-owner nor the to-owner
///      (EVM: `from != msg.sender && to != msg.sender`) → same as above
///
/// The whitelist accounts are ALWAYS supplied (fixed ExtraAccountMetaList layout) but are
/// only read/verified when `token_config.whitelist_enabled == true`. For a blocklist-only
/// mint they are ignored entirely — matching z-token semantics.
///
/// bypassing_compliance short-circuit: forced_transfer() sets this true before moving
/// value so the hook returns Ok(()) — the Solana equivalent of `super._update()`.
///
/// Account indices (MUST match ExtraAccountMetaList registration order):
///   [0] source_token_account   [1] mint          [2] destination_token_account
///   [3] authority              [4] extra_account_meta_list (validation account)
///   [5] token_config           [6] from_whitelist   [7] from_blocklist
///   [8] to_whitelist           [9] to_blocklist    [10] authority_whitelist  [11] authority_blocklist
pub fn execute_transfer_hook(ctx: Context<Execute>, _amount: u64) -> Result<()> {
    // ---- Bypass for forcedTransfer (mirrors super._update()) ----
    if ctx.accounts.token_config.bypassing_compliance {
        return Ok(());
    }

    // ---- 1. Pause check (before any other check) ----
    require!(
        !ctx.accounts.token_config.paused,
        SynthesysTokenError::AllTransfersPaused
    );

    let whitelist_enabled = ctx.accounts.token_config.whitelist_enabled;
    let mint_key = ctx.accounts.mint.key();
    let from_owner = read_token_account_owner(&ctx.accounts.source_token_account)?;
    let to_owner = read_token_account_owner(&ctx.accounts.destination_token_account)?;
    let authority_key = ctx.accounts.authority.key();

    // ---- 2. from-owner compliance (blocklist precedence, then whitelist if enabled) ----
    require_compliant(
        whitelist_enabled,
        ctx.program_id,
        &mint_key,
        &from_owner,
        &ctx.accounts.from_whitelist,
        &ctx.accounts.from_blocklist,
        SynthesysTokenError::FromAddressBlocked,
        SynthesysTokenError::FromAddressNotWhitelisted,
    )?;

    // ---- 3. to-owner compliance ----
    require_compliant(
        whitelist_enabled,
        ctx.program_id,
        &mint_key,
        &to_owner,
        &ctx.accounts.to_whitelist,
        &ctx.accounts.to_blocklist,
        SynthesysTokenError::ToAddressBlocked,
        SynthesysTokenError::ToAddressNotWhitelisted,
    )?;

    // ---- 4. caller/delegate compliance (only when it is a third party) ----
    // Mirrors EVM: if (from != msg.sender && to != msg.sender) { check msg.sender }
    if authority_key != from_owner && authority_key != to_owner {
        require_compliant(
            whitelist_enabled,
            ctx.program_id,
            &mint_key,
            &authority_key,
            &ctx.accounts.authority_whitelist,
            &ctx.accounts.authority_blocklist,
            SynthesysTokenError::SenderAddressBlocked,
            SynthesysTokenError::SenderAddressNotWhitelisted,
        )?;
    }

    Ok(())
}

/// Reads the SPL/Token-2022 token account owner (bytes 32..64 of the account data).
fn read_token_account_owner(account: &UncheckedAccount) -> Result<Pubkey> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 64, SynthesysTokenError::InvalidTokenAccount);
    Ok(Pubkey::from(
        <[u8; 32]>::try_from(&data[32..64])
            .map_err(|_| error!(SynthesysTokenError::InvalidTokenAccount))?,
    ))
}

/// Verifies compliance for `owner`:
///   - Blocklist is ALWAYS enforced: the passed blocklist PDA must be the canonical one for
///     `owner`, and must NOT exist (blocklist takes precedence — checked first).
///   - Whitelist is enforced ONLY when `whitelist_enabled`: the passed whitelist PDA must be
///     canonical and MUST exist. When disabled, the whitelist account is not even inspected.
fn require_compliant(
    whitelist_enabled: bool,
    program_id: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
    whitelist: &UncheckedAccount,
    blocklist: &UncheckedAccount,
    blocked_err: SynthesysTokenError,
    not_whitelisted_err: SynthesysTokenError,
) -> Result<()> {
    // Blocklist precedence: verify address, then blocked overrides everything.
    let (expected_bl, _) = Pubkey::find_program_address(
        &[BLOCKLIST_SEED, mint.as_ref(), owner.as_ref()],
        program_id,
    );
    require_keys_eq!(blocklist.key(), expected_bl, SynthesysTokenError::InvalidAccountAddress);
    if !blocklist.data_is_empty() {
        return Err(blocked_err.into());
    }

    // Whitelist only when enabled for this mint.
    if whitelist_enabled {
        let (expected_wl, _) = Pubkey::find_program_address(
            &[WHITELIST_SEED, mint.as_ref(), owner.as_ref()],
            program_id,
        );
        require_keys_eq!(whitelist.key(), expected_wl, SynthesysTokenError::InvalidAccountAddress);
        if whitelist.data_is_empty() {
            return Err(not_whitelisted_err.into());
        }
    }

    Ok(())
}
