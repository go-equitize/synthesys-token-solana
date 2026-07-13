//! Shared low-level helpers.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    system_instruction,
};

use crate::{
    constants::{BLOCKLIST_SEED, WHITELIST_SEED},
    error::SynthesysTokenError,
};

/// Enforce the optional-whitelist rule for one address, uniformly across every
/// direct-call instruction.
///
/// - `whitelist_enabled == false` → no-op (blocklist-only mint; the whitelist account, if
///   supplied at all, is ignored).
/// - `whitelist_enabled == true`  → the whitelist account is MANDATORY. If the caller
///   omitted it, revert with `WhitelistAccountMissing`. Otherwise re-derive the canonical
///   whitelist PDA for `owner` under `mint` and require the supplied account to (a) match
///   that address and (b) exist — i.e. `owner` is actually whitelisted — reverting with
///   `not_whitelisted_err` if not.
///
/// Re-deriving the address here (rather than trusting Anchor `seeds`) is what stops a caller
/// from substituting a different address's whitelist PDA to satisfy the check.
pub fn enforce_whitelist<'info>(
    whitelist_enabled: bool,
    program_id: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
    whitelist: Option<&UncheckedAccount<'info>>,
    not_whitelisted_err: SynthesysTokenError,
) -> Result<()> {
    if !whitelist_enabled {
        return Ok(());
    }

    let account = whitelist
        .ok_or(error!(SynthesysTokenError::WhitelistAccountMissing))?;

    let (expected, _) =
        Pubkey::find_program_address(&[WHITELIST_SEED, mint.as_ref(), owner.as_ref()], program_id);
    require_keys_eq!(
        account.key(),
        expected,
        SynthesysTokenError::InvalidAccountAddress
    );
    // Note: `require!` cannot take a runtime error variable (it treats a bare identifier as
    // an ErrorCode variant name), so return the caller-supplied error explicitly.
    if account.data_is_empty() {
        return Err(not_whitelisted_err.into());
    }

    Ok(())
}

/// Re-derive the canonical blocklist PDA for `owner` and require it does NOT exist.
///
/// Uniform blocklist counterpart to `enforce_whitelist`: blocklist is always mandatory
/// (both compliance modes), so there is no `enabled` branch. Re-deriving here (rather than
/// trusting Anchor `seeds`) is what stops a caller from substituting a different address's
/// blocklist PDA to satisfy the check — needed for handlers where the owner is read from an
/// inner account field (e.g. `token_account.owner`) rather than an `#[instruction(..)]` arg,
/// so Anchor's own `seeds` constraint can't derive it at account-resolution time.
pub fn enforce_not_blocklisted<'info>(
    program_id: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
    blocklist: &UncheckedAccount<'info>,
    blocked_err: SynthesysTokenError,
) -> Result<()> {
    let (expected, _) =
        Pubkey::find_program_address(&[BLOCKLIST_SEED, mint.as_ref(), owner.as_ref()], program_id);
    require_keys_eq!(
        blocklist.key(),
        expected,
        SynthesysTokenError::InvalidAccountAddress
    );
    if !blocklist.data_is_empty() {
        return Err(blocked_err.into());
    }

    Ok(())
}

/// Create a program-owned PDA of exactly `space` bytes, funded to rent-exemption.
///
/// Unlike a bare `system_instruction::create_account`, this is safe against the
/// "account already funded" griefing vector: `create_account` aborts with
/// `AccountAlreadyInUse` if an attacker pre-sends lamports to the (deterministic)
/// PDA address, which would otherwise permanently block role grants / hook init.
/// When the target already holds lamports we top it up (if needed) and then
/// `allocate` + `assign` it, exactly like Anchor's `#[account(init)]` fallback.
///
/// `signer_seeds` must contain the PDA's full seed set including the bump.
pub fn create_managed_pda<'info>(
    target: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    space: usize,
    owner: &Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let rent = Rent::get()?;
    let required = rent.minimum_balance(space);
    let current = target.lamports();

    if current == 0 {
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                target.key,
                required,
                space as u64,
                owner,
            ),
            &[payer.clone(), target.clone(), system_program.clone()],
            signer_seeds,
        )?;
    } else {
        // Pre-funded (possibly by a griefer). Top up to rent-exemption, then take
        // ownership via allocate + assign (the PDA signs both via seeds).
        if required > current {
            invoke(
                &system_instruction::transfer(payer.key, target.key, required - current),
                &[payer.clone(), target.clone(), system_program.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(target.key, space as u64),
            &[target.clone(), system_program.clone()],
            signer_seeds,
        )?;
        invoke_signed(
            &system_instruction::assign(target.key, owner),
            &[target.clone(), system_program.clone()],
            signer_seeds,
        )?;
    }

    Ok(())
}
