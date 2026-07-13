use anchor_lang::prelude::*;
use anchor_spl::token_interface::{approve, Approve};

use crate::{
    constants::*,
    context::ApproveTokens,
    error::SynthesysTokenError,
    util::enforce_whitelist,
};

/// Compliance-gated approve — mirrors _approve() override.
///
/// EVM _approve checks:
///   1. if (paused()) revert AllTransfersPaused
///   2. blocklist(owner) → revert FromAddressBlocked
///   3. (whitelist_enabled) !whitelist(owner) → revert FromAddressNotWhitelisted
///   4. blocklist(spender) → revert ToAddressBlocked
///   5. (whitelist_enabled) !whitelist(spender) → revert ToAddressNotWhitelisted
///
/// Solana notes:
///   - Owner blocklist (check 2): enforced by freeze state too, but checked explicitly here.
///   - Spender compliance (checks 4 & 5): checked here explicitly.
///
/// LIMITATION: Users can call Token-2022 approve directly, bypassing this wrapper.
/// The transfer hook compensates by checking the delegate (authority) at transfer time.
pub fn approve_handler(ctx: Context<ApproveTokens>, amount: u64) -> Result<()> {
    let whitelist_enabled = ctx.accounts.token_config.whitelist_enabled;
    let signer_key = ctx.accounts.signer.key();
    let delegate_key = ctx.accounts.delegate.key();
    let mint_key = ctx.accounts.mint.key();

    // 1. Pause.
    require!(
        !ctx.accounts.token_config.paused,
        SynthesysTokenError::AllTransfersPaused
    );

    // 2. Owner blocklist (always). owner == signer; owner_blocklist seeds verified by Anchor.
    require!(
        ctx.accounts.owner_blocklist.data_is_empty(),
        SynthesysTokenError::FromAddressBlocked
    );

    // 3. Owner whitelist (only when enabled).
    enforce_whitelist(
        whitelist_enabled,
        ctx.program_id,
        &mint_key,
        &signer_key,
        ctx.accounts.owner_whitelist.as_ref(),
        SynthesysTokenError::FromAddressNotWhitelisted,
    )?;

    // 4. Spender (delegate) blocklist (always). Verify PDA address, then require empty.
    //    Mirrors: blocklist(spender) → revert ToAddressBlocked
    let expected_bl = Pubkey::find_program_address(
        &[BLOCKLIST_SEED, mint_key.as_ref(), delegate_key.as_ref()],
        ctx.program_id,
    )
    .0;
    require_keys_eq!(
        ctx.accounts.delegate_blocklist.key(),
        expected_bl,
        SynthesysTokenError::InvalidAccountAddress
    );
    require!(
        ctx.accounts.delegate_blocklist.data_is_empty(),
        SynthesysTokenError::ToAddressBlocked
    );

    // 5. Spender (delegate) whitelist (only when enabled).
    //    Mirrors: !whitelist(spender) → revert ToAddressNotWhitelisted
    enforce_whitelist(
        whitelist_enabled,
        ctx.program_id,
        &mint_key,
        &delegate_key,
        ctx.accounts.delegate_whitelist.as_ref(),
        SynthesysTokenError::ToAddressNotWhitelisted,
    )?;

    // Approve delegation (owner is the signer).
    approve(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Approve {
                to: ctx.accounts.owner_token_account.to_account_info(),
                delegate: ctx.accounts.delegate.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            },
        ),
        amount,
    )?;

    Ok(())
}
