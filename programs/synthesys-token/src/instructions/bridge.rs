use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::token_interface::spl_token_2022;

use crate::{
    constants::*,
    context::{PostBridgeRestore, PreBridgeSend},
    error::SynthesysTokenError,
    events::{BridgeSendClosed, BridgeSendOpened},
    util::enforce_whitelist,
};

/// Asserts the router `ccip_send` bridges exactly one token with `token_indexes == [0]`,
/// so it debits `remaining_accounts[0]` == account index CCIP_SEND_USER_TOKEN_ACCOUNT_INDEX.
/// Every arg before `token_indexes` is length-prefixed Borsh and skipped without decode:
/// disc(8), dest_chain_selector u64(8), message{ receiver bytes, data bytes,
/// token_amounts Vec<SVMTokenAmount>, fee_token pubkey(32), extra_args bytes },
/// token_indexes bytes. Fails closed on any malformed / multi-token / non-zero-index data.
fn require_single_token_send_to_offset_zero(data: &[u8]) -> Result<()> {
    fn read_len(data: &[u8], off: usize) -> Option<(usize, usize)> {
        let end = off.checked_add(4)?;
        let len = u32::from_le_bytes(data.get(off..end)?.try_into().ok()?) as usize;
        Some((len, end))
    }
    fn skip_bytes(data: &[u8], off: usize) -> Option<usize> {
        let (len, off) = read_len(data, off)?;
        off.checked_add(len)
    }

    let ok = (|| -> Option<()> {
        let mut off = CCIP_SEND_DISCRIMINATOR.len();
        off = off.checked_add(8)?; // dest_chain_selector
        off = skip_bytes(data, off)?; // message.receiver
        off = skip_bytes(data, off)?; // message.data
        let (n_tokens, after_len) = read_len(data, off)?; // message.token_amounts
        if n_tokens != 1 {
            return None;
        }
        off = after_len.checked_add(n_tokens.checked_mul(CCIP_SVM_TOKEN_AMOUNT_SIZE)?)?;
        off = off.checked_add(32)?; // message.fee_token
        off = skip_bytes(data, off)?; // message.extra_args
        let (n_idx, after_idx_len) = read_len(data, off)?; // token_indexes
        if n_idx != 1 || *data.get(after_idx_len)? != 0 {
            return None;
        }
        (after_idx_len.checked_add(1)? == data.len()).then_some(()) // no trailing bytes
    })();

    require!(
        ok.is_some(),
        SynthesysTokenError::UnexpectedCcipSendAccountLayout
    );
    Ok(())
}

/// Opens a compliant CCIP bridge-send window.
///
/// No EVM parallel — Solana-specific workaround for the deployed CCIP router's
/// inability to forward Token-2022 transfer-hook extra accounts (the router's onramp
/// CPI carries only the 4 base accounts and cannot resolve this mint's
/// ExtraAccountMetaList). Compliance-checks the caller
/// exactly as the transfer hook itself would (pause, blocklist, and whitelist when
/// whitelist_enabled), then requires — via the Instructions sysvar — that a matching
/// `post_bridge_restore` call exists later in this SAME transaction with nothing but
/// ComputeBudget instructions and the configured router's `ccip_send` in between. Only
/// then does it disable the transfer hook.
///
/// This is permissionless (gated on compliance, not ADMIN_ROLE) so any compliant user
/// can self-serve bridge their own tokens without an admin in the loop.
///
/// Solana's whole-transaction atomicity guarantees the hook can never be left
/// disabled: if the paired `post_bridge_restore` (or the exact allowed instruction
/// sequence) is missing, this instruction fails and the entire transaction —
/// including the attempted toggle — is rolled back. The strict instruction
/// allowlist (rather than "any instruction on the router program") also closes the
/// sandwich attack where an unrelated transfer/mint is inserted into the window
/// while the hook is off.
pub fn pre_bridge_send_handler(ctx: Context<PreBridgeSend>) -> Result<()> {
    require!(!ctx.accounts.token_config.paused, SynthesysTokenError::AllTransfersPaused);

    let router_program_id = ctx.accounts.token_config.ccip_router_program_id;
    require!(
        router_program_id != Pubkey::default(),
        SynthesysTokenError::CcipRouterNotConfigured
    );

    let whitelist_enabled = ctx.accounts.token_config.whitelist_enabled;
    let signer_key = ctx.accounts.signer.key();
    let mint_key = ctx.accounts.mint.key();

    // Compliance check on the caller — mirrors the "authority" branch the transfer
    // hook itself enforces (see Execute handler in transfer_hook.rs). Blocklist always;
    // whitelist only when enabled (and then the whitelist account is mandatory).
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

    // ---- Owner check on the token account actually being bridged ----
    // The hook normally also checks the FROM-OWNER independently of the authority
    // (transfer_hook.rs checks from-owner unconditionally, then authority only when
    // it's a third party). pre_bridge_send can't replicate that against the
    // sandwiched ccip_send — the router is an opaque CPI into a program we don't
    // control, so we cannot see which account(s) it will actually debit. The only
    // sound gate is refusing to open the window at all unless the signer IS the
    // owner of the account they declare here: a compliant delegate can no longer
    // ride a still-valid approval to move a blocklisted owner's funds through the
    // bridge window (it can still move them via a normal transfer_checked, which
    // re-checks the owner's compliance at hook time — that path was never at risk).
    require_keys_eq!(
        ctx.accounts.source_token_account.owner,
        signer_key,
        SynthesysTokenError::TokenAccountOwnerMismatch
    );

    // ---- Transaction introspection: enforce pairing + sandwich guard ----
    // The walker reads only top-level instructions via the sysvar, so a nested-CPI
    // caller would present a smaller view than the real tx. Require top-level.
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        SynthesysTokenError::BridgeCallerMustBeTopLevel
    );

    let source_token_account_key = ctx.accounts.source_token_account.key();
    let ixs_sysvar = &ctx.accounts.instructions_sysvar.to_account_info();
    let current_index = load_current_index_checked(ixs_sysvar)?;
    let post_restore_discriminator = crate::instruction::PostBridgeRestore::DISCRIMINATOR;

    let mut index = current_index
        .checked_add(1)
        .ok_or(SynthesysTokenError::ArithmeticOverflow)?;
    let mut found_restore = false;
    let mut found_send = false;

    loop {
        let Ok(ix) = load_instruction_at_checked(index as usize, ixs_sysvar) else {
            break;
        };

        if ix.program_id == crate::ID && ix.data.starts_with(&post_restore_discriminator) {
            // Confirm it targets the SAME mint — PostBridgeRestore's `mint` account
            // is account index 0 in its account list (see context.rs ordering).
            require!(
                ix.accounts.first().map(|a| a.pubkey) == Some(mint_key),
                SynthesysTokenError::MissingPostBridgeRestore
            );
            found_restore = true;
            break;
        }

        // Anything in the window must be either a ComputeBudget instruction or the
        // configured router's ccip_send — nothing else. This is what prevents an
        // unrelated transfer/mint from being sandwiched in while the hook is off.
        let is_compute_budget = ix.program_id == COMPUTE_BUDGET_PROGRAM_ID;
        let is_router_send =
            ix.program_id == router_program_id && ix.data.starts_with(&CCIP_SEND_DISCRIMINATOR);

        if is_router_send {
            // One caller compliance check gates exactly one outbound send.
            require!(!found_send, SynthesysTokenError::MultipleSendsInBridgeWindow);
            found_send = true;

            // Bind the send to its account layout + token routing (not just the 8-byte
            // discriminator) and force the debited account to the one we ownership-checked.
            require_single_token_send_to_offset_zero(&ix.data)?;
            require!(
                ix.accounts.len() > CCIP_SEND_USER_TOKEN_ACCOUNT_INDEX,
                SynthesysTokenError::UnexpectedCcipSendAccountLayout
            );
            let debited = &ix.accounts[CCIP_SEND_USER_TOKEN_ACCOUNT_INDEX];
            require!(
                debited.pubkey == source_token_account_key && debited.is_writable,
                SynthesysTokenError::BridgeSourceAccountMismatch
            );
        } else {
            require!(
                is_compute_budget,
                SynthesysTokenError::DisallowedInstructionInBridgeWindow
            );
        }

        index = index.checked_add(1).ok_or(SynthesysTokenError::ArithmeticOverflow)?;
    }

    require!(found_restore, SynthesysTokenError::MissingPostBridgeRestore);
    // Never toggle the hook off for a window that performs no bridging.
    require!(found_send, SynthesysTokenError::BridgeSendMissing);

    // ---- Disable the transfer hook for the duration of this transaction ----
    let authority_bump = ctx.accounts.token_config.authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, mint_key.as_ref(), &[authority_bump]]];

    let ix = spl_token_2022::extension::transfer_hook::instruction::update(
        ctx.accounts.token_program.key,
        &mint_key,
        ctx.accounts.authority_pda.key,
        &[],
        None,
    )?;
    invoke_signed(
        &ix,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.authority_pda.to_account_info(),
        ],
        signer_seeds,
    )?;

    emit!(BridgeSendOpened {
        signer: signer_key
    });
    Ok(())
}

/// Restores the transfer hook disabled by `pre_bridge_send`.
///
/// No compliance gate needed — re-enabling the hook only restores enforcement, so
/// it's always safe to call, including standalone as a manual recovery if a bridge
/// flow ever needs to be re-armed out of band.
pub fn post_bridge_restore_handler(ctx: Context<PostBridgeRestore>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let authority_bump = ctx.accounts.token_config.authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, mint_key.as_ref(), &[authority_bump]]];

    let ix = spl_token_2022::extension::transfer_hook::instruction::update(
        ctx.accounts.token_program.key,
        &mint_key,
        ctx.accounts.authority_pda.key,
        &[],
        Some(crate::ID),
    )?;
    invoke_signed(
        &ix,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.authority_pda.to_account_info(),
        ],
        signer_seeds,
    )?;

    emit!(BridgeSendClosed {});
    Ok(())
}
