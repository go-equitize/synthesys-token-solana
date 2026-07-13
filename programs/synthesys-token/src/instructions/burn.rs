use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn, Burn};

use crate::{
    constants::*,
    context::{BurnAccount, BurnFrom, BurnSelf},
    error::SynthesysTokenError,
    events::TokenBurned,
    util::{enforce_not_blocklisted, enforce_whitelist},
};

/// Mirrors: function burn(uint256 amount) public onlyRole(BURNER_ROLE)
/// Signer burns from their own token account.
///
/// EVM _update checks for a burn from self (from == msg.sender):
///   1. if (paused()) revert AllTransfersPaused
///   2. from == msg.sender → skip sender check
///   3. blocklist(from) / whitelist(from) checks still apply
///
/// On Solana, per-ATA freeze state is NOT a sufficient proxy for per-owner compliance
/// (an owner can hold multiple ATAs, only one of which gets frozen by add_blocklist /
/// remove_whitelist) — mirroring the multi-ATA gap the transfer hook already closes for
/// transfers. So we explicitly re-derive and check the signer's (owner's) blocklist/
/// whitelist PDAs here too, rather than relying solely on Token-2022 rejecting a burn on a
/// frozen account.
pub fn burn_self_handler(ctx: Context<BurnSelf>, amount: u64) -> Result<()> {
    // Pause check — mirrors: if (paused()) revert AllTransfersPaused()
    require!(!ctx.accounts.token_config.paused, SynthesysTokenError::AllTransfersPaused);

    let whitelist_enabled = ctx.accounts.token_config.whitelist_enabled;
    let signer_key = ctx.accounts.signer.key();
    let mint_key = ctx.accounts.mint.key();

    // Owner (== signer) per-owner compliance — mirrors EVM blocklist(from)/whitelist(from).
    enforce_not_blocklisted(
        ctx.program_id,
        &mint_key,
        &signer_key,
        &ctx.accounts.signer_owner_blocklist,
        SynthesysTokenError::FromAddressBlocked,
    )?;
    enforce_whitelist(
        whitelist_enabled,
        ctx.program_id,
        &mint_key,
        &signer_key,
        ctx.accounts.signer_whitelist.as_ref(),
        SynthesysTokenError::FromAddressNotWhitelisted,
    )?;

    // Signer is both authority and owner — Token-2022 enforces frozen state.
    burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.signer_token_account.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            },
        ),
        amount,
    )?;

    emit!(TokenBurned {
        from: ctx.accounts.signer.key(),
        amount,
    });

    Ok(())
}

/// Mirrors: function burn(address account, uint256 amount) public onlyRole(BURNER_ROLE)
/// BURNER_ROLE burns from any compliant (unfrozen) account via the permanent delegate PDA.
///
/// EVM _update checks:
///   1. if (paused()) revert AllTransfersPaused
///   2. if (from != msg.sender && to != msg.sender): sender compliance
///   3. if (from != address(0)): blocklist(from) / whitelist(from)
///
/// On Solana, Token-2022 rejects burn on frozen accounts, so a frozen (non-compliant)
/// account cannot be burned here — use force_burn for that case.
pub fn burn_account_handler(ctx: Context<BurnAccount>, amount: u64) -> Result<()> {
    // Pause check.
    require!(!ctx.accounts.token_config.paused, SynthesysTokenError::AllTransfersPaused);

    let whitelist_enabled = ctx.accounts.token_config.whitelist_enabled;
    let signer_key = ctx.accounts.signer.key();
    let owner = ctx.accounts.from_token_account.owner;
    let mint_key = ctx.accounts.mint.key();

    // Caller (msg.sender) compliance — mirrors the first branch of _update:
    //   if (from != msg.sender && to != msg.sender) { blocklist(sender); whitelist(sender) }
    // For a burn, to = address(0), so the branch applies whenever the burner is not the
    // account owner. Blocklist before whitelist.
    if owner != signer_key {
        require!(
            ctx.accounts.signer_blocklist.data_is_empty(),
            SynthesysTokenError::SenderAddressBlocked
        );
        enforce_whitelist(
            whitelist_enabled,
            ctx.program_id,
            &mint_key,
            &signer_key,
            ctx.accounts.signer_whitelist.as_ref(),
            SynthesysTokenError::SenderAddressNotWhitelisted,
        )?;
    }

    // Owner per-owner compliance — mirrors EVM blocklist(from)/whitelist(from), independent
    // of the caller branch above (a burner burning from THEIR OWN account still needs the
    // account's owner — themselves — to be compliant; that's just owner == signer here).
    // Freeze state alone can't represent this: an owner can hold multiple ATAs, only one of
    // which gets frozen by add_blocklist / remove_whitelist. Non-compliant holders' tokens
    // must go through force_burn instead.
    enforce_not_blocklisted(
        ctx.program_id,
        &mint_key,
        &owner,
        &ctx.accounts.owner_blocklist,
        SynthesysTokenError::FromAddressBlocked,
    )?;
    enforce_whitelist(
        whitelist_enabled,
        ctx.program_id,
        &mint_key,
        &owner,
        ctx.accounts.owner_whitelist.as_ref(),
        SynthesysTokenError::FromAddressNotWhitelisted,
    )?;

    let authority_bump = ctx.accounts.token_config.authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        AUTHORITY_SEED,
        mint_key.as_ref(),
        &[authority_bump],
    ]];

    // Burn via permanent delegate (authority_pda).
    // Token-2022 will reject if from_token_account is frozen.
    burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.from_token_account.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    emit!(TokenBurned {
        from: owner,
        amount,
    });

    Ok(())
}

/// Mirrors: function burnFrom(address account, uint256 amount) public onlyRole(BURNER_ROLE)
/// BURNER_ROLE burns via a user-granted allowance (delegate approval).
/// The signer must be the approved delegate of from_token_account.
///
/// On EVM: _spendAllowance(account, msg.sender, amount) consumes the allowance.
/// On Solana: Token-2022 enforces delegate authority and consumes the approved amount.
pub fn burn_from_handler(ctx: Context<BurnFrom>, amount: u64) -> Result<()> {
    // Pause check.
    require!(!ctx.accounts.token_config.paused, SynthesysTokenError::AllTransfersPaused);

    let whitelist_enabled = ctx.accounts.token_config.whitelist_enabled;
    let signer_key = ctx.accounts.signer.key();
    let owner = ctx.accounts.from_token_account.owner;
    let mint_key = ctx.accounts.mint.key();

    // Caller (msg.sender) compliance — mirrors the first branch of _update:
    //   if (from != msg.sender && to != msg.sender) { blocklist(sender); whitelist(sender) }
    // For burnFrom, to = address(0); the branch applies whenever the burner is not the
    // account owner. Blocklist before whitelist.
    if owner != signer_key {
        require!(
            ctx.accounts.signer_blocklist.data_is_empty(),
            SynthesysTokenError::SenderAddressBlocked
        );
        enforce_whitelist(
            whitelist_enabled,
            ctx.program_id,
            &mint_key,
            &signer_key,
            ctx.accounts.signer_whitelist.as_ref(),
            SynthesysTokenError::SenderAddressNotWhitelisted,
        )?;
    }

    // Owner per-owner compliance — mirrors EVM blocklist(from)/whitelist(from), independent
    // of the caller branch above. Freeze state alone can't represent this (multi-ATA gap).
    enforce_not_blocklisted(
        ctx.program_id,
        &mint_key,
        &owner,
        &ctx.accounts.owner_blocklist,
        SynthesysTokenError::FromAddressBlocked,
    )?;
    enforce_whitelist(
        whitelist_enabled,
        ctx.program_id,
        &mint_key,
        &owner,
        ctx.accounts.owner_whitelist.as_ref(),
        SynthesysTokenError::FromAddressNotWhitelisted,
    )?;

    // Signer must be the approved delegate (enforced by token::authority = signer constraint).
    // Token-2022 will reject if from_token_account is frozen.
    burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.from_token_account.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            },
        ),
        amount,
    )?;

    emit!(TokenBurned {
        from: owner,
        amount,
    });

    Ok(())
}
