use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, freeze_account, mint_to, thaw_account, Burn, FreezeAccount, MintTo, ThawAccount,
};
use anchor_spl::token_2022::spl_token_2022::state::AccountState;

use crate::{
    constants::*,
    context::{ForceBurnTokens, ForcedTransfer},
    error::SynthesysTokenError,
    events::{ForceBurn, TokenForcedTransferred},
};

// ---------------------------------------------------------------------------
// forceBurn
// ---------------------------------------------------------------------------

/// Mirrors: function forceBurn(address account, uint256 amount) public onlyRole(ADMIN_ROLE)
///
/// EVM implementation:
///   if (account == address(0)) revert ERC20InvalidSender(address(0));
///   super._update(account, address(0), amount);  // BYPASSES _update override
///   emit ForceBurn(account, amount);
///
/// Solana implementation:
///   - Validates account != Pubkey::default()
///   - Thaws if frozen  (no compliance check — bypass is intentional)
///   - Burns via permanent delegate
///   - Restores prior freeze state
///
/// IMPORTANT: Token-2022 does NOT call the transfer hook on burn — so there is
/// NO hook-level compliance check here, exactly as intended. Whitelist mode is
/// irrelevant to this instruction (full bypass).
pub fn force_burn_handler(ctx: Context<ForceBurnTokens>, amount: u64) -> Result<()> {
    // Mirrors: if (account == address(0)) revert ERC20InvalidSender(address(0))
    require!(
        ctx.accounts.target_token_account.owner != Pubkey::default(),
        SynthesysTokenError::InvalidZeroAddress
    );

    let mint_key = ctx.accounts.mint.key();
    let authority_bump = ctx.accounts.token_config.authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        AUTHORITY_SEED,
        mint_key.as_ref(),
        &[authority_bump],
    ]];

    let was_frozen = ctx.accounts.target_token_account.state == AccountState::Frozen;

    // Step 1 — Thaw if frozen.
    // Token-2022 blocks burn on frozen accounts; thaw first (no compliance check).
    if was_frozen {
        thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            ThawAccount {
                account: ctx.accounts.target_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    // Step 2 — Burn via permanent delegate (no compliance checks, no hook).
    // Mirrors: super._update(account, address(0), amount)
    let target_owner = ctx.accounts.target_token_account.owner;
    burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.target_token_account.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // Step 3 — Restore the account's pre-existing freeze state (EVM parity).
    // EVM `forceBurn` calls `super._update` and never freezes, so a compliant holder
    // stays transferable after a partial burn. We mirror that by only re-freezing if the
    // account was frozen to begin with (i.e. non-compliant) — matching `forced_transfer`.
    if was_frozen {
        freeze_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            FreezeAccount {
                account: ctx.accounts.target_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    emit!(ForceBurn {
        account: target_owner,
        token_account: ctx.accounts.target_token_account.key(),
        amount,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// forcedTransfer
// ---------------------------------------------------------------------------

/// Mirrors: function forcedTransfer(address from, address to, uint256 amount) public onlyRole(ADMIN_ROLE)
///
/// EVM implementation:
///   if (from == address(0)) revert ERC20InvalidSender(address(0));
///   if (to == address(0)) revert ERC20InvalidReceiver(address(0));
///   super._update(from, to, amount);  // BYPASSES _update override (all compliance + pause)
///   emit TokenForcedTransferred(from, to, amount);
///
/// Solana implementation: burn(from) + mint_to(to), NOT a literal transfer_checked.
///   1. Validates non-zero addresses
///   2. Verifies the passed compliance-PDA addresses (address-only; see below)
///   3. Sets token_config.bypassing_compliance = true (documents the bypass)
///   4. Thaws from and to if frozen (no compliance check)
///   5. Burns `amount` from `from`, then mints `amount` to `to` — net effect is a transfer,
///      total supply is unchanged
///   6. Re-freezes accounts if they were previously non-compliant
///   7. Clears token_config.bypassing_compliance = false
///
/// COMPLIANCE-PDA ACCOUNTS ARE ADDRESS-VALIDATED ONLY, NEVER EXISTENCE-GATED. forcedTransfer
/// is an ADMIN bypass whose whole purpose includes clawing back from non-whitelisted /
/// blocklisted / frozen accounts, so we must NOT require the from/to owner to be whitelisted
/// or non-blocklisted. The accounts are retained (for structural parity with the audited
/// rwa-token and to keep the re-freeze accounting explicit) and only their PDA addresses are
/// checked. Whitelist accounts are optional: required (address-checked) when whitelist_enabled,
/// ignored otherwise.
///
/// IMPORTANT — why burn+mint instead of a literal transfer: this mint's TransferHook
/// extension points at this very program. A `transfer_checked` CPI'd from within this
/// program's own instruction would require Token-2022 to CPI back into this program (to
/// run the hook) while it is still on the call stack — Solana's runtime rejects that with
/// "Cross-program invocation reentrancy not allowed". Token-2022 does not invoke the hook
/// on burn or mint_to, so an atomic burn-then-mint achieves the same external effect without
/// re-entering this program. Atomicity is guaranteed by Solana's single-threaded execution.
pub fn forced_transfer_handler(ctx: Context<ForcedTransfer>, amount: u64) -> Result<()> {
    // Mirrors: if (from == address(0)) revert ERC20InvalidSender(address(0))
    require!(
        ctx.accounts.from_token_account.owner != Pubkey::default(),
        SynthesysTokenError::InvalidZeroAddress
    );
    // Mirrors: if (to == address(0)) revert ERC20InvalidReceiver(address(0))
    require!(
        ctx.accounts.to_token_account.owner != Pubkey::default(),
        SynthesysTokenError::InvalidZeroReceiver
    );

    // Guard against from == to (same token account): the thaw→burn→mint→re-freeze
    // sequence would double-thaw an already-thawed account and revert. Reject cleanly.
    require_keys_neq!(
        ctx.accounts.from_token_account.key(),
        ctx.accounts.to_token_account.key(),
        SynthesysTokenError::CannotTransferToSelf
    );

    let whitelist_enabled = ctx.accounts.token_config.whitelist_enabled;
    let mint_key = ctx.accounts.mint.key();
    let from_owner = ctx.accounts.from_token_account.owner;
    let to_owner = ctx.accounts.to_token_account.owner;

    // Verify the blocklist PDA addresses for from and to owners (address-only; these
    // accounts are passed as UncheckedAccounts because Anchor can't derive PDA seeds from
    // inner fields (owner) of other accounts at constraint-evaluation time).
    let expected_from_bl = Pubkey::find_program_address(
        &[BLOCKLIST_SEED, mint_key.as_ref(), from_owner.as_ref()],
        ctx.program_id,
    )
    .0;
    require_keys_eq!(
        ctx.accounts.from_owner_blocklist.key(),
        expected_from_bl,
        SynthesysTokenError::InvalidAccountAddress
    );

    let expected_to_bl = Pubkey::find_program_address(
        &[BLOCKLIST_SEED, mint_key.as_ref(), to_owner.as_ref()],
        ctx.program_id,
    )
    .0;
    require_keys_eq!(
        ctx.accounts.to_owner_blocklist.key(),
        expected_to_bl,
        SynthesysTokenError::InvalidAccountAddress
    );

    // Verify the whitelist PDA addresses ONLY when whitelist_enabled — required (else
    // WhitelistAccountMissing), address-checked, but NOT existence-gated (bypass).
    if whitelist_enabled {
        let from_wl = ctx
            .accounts
            .from_owner_whitelist
            .as_ref()
            .ok_or(error!(SynthesysTokenError::WhitelistAccountMissing))?;
        let expected_from_wl = Pubkey::find_program_address(
            &[WHITELIST_SEED, mint_key.as_ref(), from_owner.as_ref()],
            ctx.program_id,
        )
        .0;
        require_keys_eq!(
            from_wl.key(),
            expected_from_wl,
            SynthesysTokenError::InvalidAccountAddress
        );

        let to_wl = ctx
            .accounts
            .to_owner_whitelist
            .as_ref()
            .ok_or(error!(SynthesysTokenError::WhitelistAccountMissing))?;
        let expected_to_wl = Pubkey::find_program_address(
            &[WHITELIST_SEED, mint_key.as_ref(), to_owner.as_ref()],
            ctx.program_id,
        )
        .0;
        require_keys_eq!(
            to_wl.key(),
            expected_to_wl,
            SynthesysTokenError::InvalidAccountAddress
        );
    }

    // Record freeze states before we thaw (to restore them afterwards).
    let from_was_frozen = ctx.accounts.from_token_account.state == AccountState::Frozen;
    let to_was_frozen = ctx.accounts.to_token_account.state == AccountState::Frozen;

    let authority_bump = ctx.accounts.token_config.authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        AUTHORITY_SEED,
        mint_key.as_ref(),
        &[authority_bump],
    ]];

    // ---- BEGIN BYPASS WINDOW ----
    // Set flag: transfer hook will return Ok(()) immediately.
    // Mirrors: super._update() bypassing the override in EVM.
    ctx.accounts.token_config.bypassing_compliance = true;

    // Thaw from (if frozen) — required for the burn to succeed.
    if from_was_frozen {
        thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            ThawAccount {
                account: ctx.accounts.from_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    // Thaw to (if frozen) — required for the mint_to to succeed.
    if to_was_frozen {
        thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            ThawAccount {
                account: ctx.accounts.to_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    // Move value via burn(from) + mint_to(to) — see doc comment above for why a literal
    // transfer_checked cannot be used when this program is also the mint's hook target.
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
    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.to_token_account.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // ---- END BYPASS WINDOW ----
    // Clear flag before any further checks.
    ctx.accounts.token_config.bypassing_compliance = false;

    // Re-freeze from if it was frozen before (non-compliant: blocklisted OR not whitelisted).
    // We restore the freeze state that existed before the forced transfer.
    if from_was_frozen {
        freeze_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            FreezeAccount {
                account: ctx.accounts.from_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    // Re-freeze to if it was frozen before.
    if to_was_frozen {
        freeze_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            FreezeAccount {
                account: ctx.accounts.to_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    emit!(TokenForcedTransferred {
        from: from_owner,
        to: to_owner,
        from_token_account: ctx.accounts.from_token_account.key(),
        to_token_account: ctx.accounts.to_token_account.key(),
        amount,
    });

    Ok(())
}
