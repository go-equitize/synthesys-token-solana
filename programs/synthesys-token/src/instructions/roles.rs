use anchor_lang::prelude::*;

use crate::{
    constants::*,
    context::{GrantRole, RevokeRole},
    error::SynthesysTokenError,
    events::{RoleGranted, RoleRevoked},
};

fn role_seed(role: &str) -> Result<&'static [u8]> {
    match role {
        "ADMIN_ROLE" => Ok(ADMIN_ROLE),
        "MINTER_ROLE" => Ok(MINTER_ROLE),
        "BURNER_ROLE" => Ok(BURNER_ROLE),
        "DEFAULT_ADMIN_ROLE" => Ok(DEFAULT_ADMIN_ROLE),
        _ => err!(SynthesysTokenError::Unauthorized),
    }
}

/// Mirrors: grantRole(bytes32 role, address account)
///          onlyRole(getRoleAdmin(role)) — DEFAULT_ADMIN_ROLE is admin of all roles.
pub fn grant_role_handler(
    ctx: Context<GrantRole>,
    role: String,
    grantee: Pubkey,
) -> Result<()> {
    let role_bytes = role_seed(&role)?;
    let mint_key = ctx.accounts.mint.key();

    // Verify the role_entry PDA address matches expected derivation.
    let (expected_pda, bump) = Pubkey::find_program_address(
        &[ROLE_SEED, mint_key.as_ref(), role_bytes, grantee.as_ref()],
        ctx.program_id,
    );
    require_keys_eq!(
        ctx.accounts.role_entry.key(),
        expected_pda,
        SynthesysTokenError::InvalidAccountAddress
    );

    // If PDA already exists, the role is already granted — idempotent (like EVM AccessControl).
    if !ctx.accounts.role_entry.data_is_empty() {
        return Ok(()); // Already has the role
    }

    // Track ADMIN_ROLE / DEFAULT_ADMIN_ROLE population so revoke_role can refuse to drop
    // the last holder of either (see LastAdminCannotBeRevoked).
    if role_bytes == DEFAULT_ADMIN_ROLE {
        ctx.accounts.token_config.default_admin_count = ctx
            .accounts
            .token_config
            .default_admin_count
            .checked_add(1)
            .ok_or(SynthesysTokenError::ArithmeticOverflow)?;
    } else if role_bytes == ADMIN_ROLE {
        ctx.accounts.token_config.admin_count = ctx
            .accounts
            .token_config
            .admin_count
            .checked_add(1)
            .ok_or(SynthesysTokenError::ArithmeticOverflow)?;
    }

    // Create the PDA. Pre-fund-safe (see util::create_managed_pda): a griefer cannot
    // block a specific (role, grantee) grant by pre-sending lamports to the PDA address.
    let signer_seeds: &[&[&[u8]]] = &[&[
        ROLE_SEED,
        mint_key.as_ref(),
        role_bytes,
        grantee.as_ref(),
        &[bump],
    ]];

    crate::util::create_managed_pda(
        &ctx.accounts.role_entry.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        8,
        ctx.program_id,
        signer_seeds,
    )?;

    // Write the Anchor discriminator for RoleEntry.
    // Anchor discriminator = sha256("account:RoleEntry")[..8]
    let discriminator = <crate::state::RoleEntry as anchor_lang::Discriminator>::DISCRIMINATOR;
    ctx.accounts.role_entry.try_borrow_mut_data()?[..8].copy_from_slice(&discriminator);

    // `sender` records who authorized the grant (the DEFAULT_ADMIN_ROLE holder), not who
    // paid for the account — mirrors EVM's `msg.sender` in RoleGranted, which is the
    // caller's identity regardless of who relayed/paid gas.
    emit!(RoleGranted {
        role,
        account: grantee,
        sender: ctx.accounts.authority.key(),
    });

    Ok(())
}

/// Mirrors: revokeRole(bytes32 role, address account)
///          onlyRole(getRoleAdmin(role)) — DEFAULT_ADMIN_ROLE.
pub fn revoke_role_handler(
    ctx: Context<RevokeRole>,
    role: String,
    grantee: Pubkey,
) -> Result<()> {
    let role_bytes = role_seed(&role)?;
    let mint_key = ctx.accounts.mint.key();

    // Verify address.
    let (expected_pda, _) = Pubkey::find_program_address(
        &[ROLE_SEED, mint_key.as_ref(), role_bytes, grantee.as_ref()],
        ctx.program_id,
    );
    require_keys_eq!(
        ctx.accounts.role_entry.key(),
        expected_pda,
        SynthesysTokenError::InvalidAccountAddress
    );

    let role_info = ctx.accounts.role_entry.to_account_info();

    // Only act if the role is actually granted (PDA exists and is program-owned).
    // Guards against (a) emitting a false RoleRevoked event when the role was never
    // granted — which would desync off-chain role/sanctions monitors — and (b) draining
    // stray lamports from an unrelated system-owned account sitting at this address.
    if role_info.owner != ctx.program_id || role_info.data_is_empty() {
        return Ok(());
    }

    // Refuse to drop the last DEFAULT_ADMIN_ROLE or ADMIN_ROLE holder for this mint —
    // doing so would permanently brick role administration (no one left who could
    // grant/revoke roles, or administer pause/lists/force-ops), recoverable only by a
    // full program upgrade.
    if role_bytes == DEFAULT_ADMIN_ROLE {
        require!(
            ctx.accounts.token_config.default_admin_count > 1,
            SynthesysTokenError::LastAdminCannotBeRevoked
        );
        ctx.accounts.token_config.default_admin_count -= 1;
    } else if role_bytes == ADMIN_ROLE {
        require!(
            ctx.accounts.token_config.admin_count > 1,
            SynthesysTokenError::LastAdminCannotBeRevoked
        );
        ctx.accounts.token_config.admin_count -= 1;
    }

    // Close PDA: refund lamports to payer and zero out data.
    let dest = ctx.accounts.payer.to_account_info();
    **dest.lamports.borrow_mut() += **role_info.lamports.borrow();
    **role_info.lamports.borrow_mut() = 0;
    role_info.try_borrow_mut_data()?.fill(0);

    // `sender` records who authorized the revocation, not who received the rent refund.
    emit!(RoleRevoked {
        role,
        account: grantee,
        sender: ctx.accounts.authority.key(),
    });

    Ok(())
}
