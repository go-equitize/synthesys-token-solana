use anchor_lang::prelude::*;

use crate::{
    context::SetPause,
    events::{Paused, Unpaused},
};

/// Mirrors: function pause() public onlyRole(ADMIN_ROLE)
/// Sets token_config.paused = true; the transfer hook and all compliance-gated
/// instructions check this flag.
pub fn pause_handler(ctx: Context<SetPause>) -> Result<()> {
    ctx.accounts.token_config.paused = true;
    emit!(Paused {
        account: ctx.accounts.signer.key(),
    });
    Ok(())
}

/// Mirrors: function unpause() public onlyRole(ADMIN_ROLE)
pub fn unpause_handler(ctx: Context<SetPause>) -> Result<()> {
    ctx.accounts.token_config.paused = false;
    emit!(Unpaused {
        account: ctx.accounts.signer.key(),
    });
    Ok(())
}
