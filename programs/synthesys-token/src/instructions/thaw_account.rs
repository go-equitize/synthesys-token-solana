use anchor_lang::prelude::*;
use anchor_spl::token_interface::{thaw_account, ThawAccount};
use anchor_spl::token_2022::spl_token_2022::state::AccountState;

use crate::{
    constants::*,
    context::ThawTokenAccount,
    error::SynthesysTokenError,
    events::AccountThawed,
    util::enforce_whitelist,
};

/// Permissionless thaw — anyone can call this for any frozen token account,
/// but it only succeeds if the token account's owner is NOT blocklisted and — when
/// whitelist_enabled — is whitelisted.
///
/// No EVM parallel — required on Solana because DefaultAccountState=Frozen means new token
/// accounts start frozen (in BOTH compliance modes). This is the "account activation" step
/// users must perform after being permitted.
///
/// Flow:
///   1. Confirm owner is NOT blocklisted (blocklist PDA absent) — always
///   2. Confirm owner is whitelisted (whitelist PDA exists) — only when whitelist_enabled
///   3. Thaw the account via freeze_authority PDA
pub fn thaw_token_account_handler(ctx: Context<ThawTokenAccount>) -> Result<()> {
    // Pause halts all activity, including account activation (parity with the mint path,
    // which is also pause-gated).
    require!(
        !ctx.accounts.token_config.paused,
        SynthesysTokenError::AllTransfersPaused
    );

    let whitelist_enabled = ctx.accounts.token_config.whitelist_enabled;
    let owner = ctx.accounts.token_account.owner;
    let mint_key = ctx.accounts.mint.key();

    // 1. Blocklist (always). Verify PDA address, then require owner is NOT blocklisted.
    //    Mirrors: blocklist.isBlocklisted(to) → reject
    let expected_bl = Pubkey::find_program_address(
        &[BLOCKLIST_SEED, mint_key.as_ref(), owner.as_ref()],
        ctx.program_id,
    )
    .0;
    require_keys_eq!(
        ctx.accounts.owner_blocklist.key(),
        expected_bl,
        SynthesysTokenError::InvalidAccountAddress
    );
    require!(
        ctx.accounts.owner_blocklist.data_is_empty(),
        SynthesysTokenError::FromAddressBlocked
    );

    // 2. Whitelist (only when enabled). Mandatory account when enabled.
    //    Mirrors: !whitelist.isWhitelisted(to) → reject
    enforce_whitelist(
        whitelist_enabled,
        ctx.program_id,
        &mint_key,
        &owner,
        ctx.accounts.owner_whitelist.as_ref(),
        SynthesysTokenError::FromAddressNotWhitelisted,
    )?;

    // 3. Only thaw if the account is currently frozen.
    if ctx.accounts.token_account.state == AccountState::Frozen {
        let authority_bump = ctx.accounts.token_config.authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            AUTHORITY_SEED,
            mint_key.as_ref(),
            &[authority_bump],
        ]];

        thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            ThawAccount {
                account: ctx.accounts.token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    emit!(AccountThawed {
        token_account: ctx.accounts.token_account.key(),
        owner,
    });

    Ok(())
}
