use anchor_lang::prelude::*;

use crate::{
    context::{SetCCIPAdmin, SetCCIPRouter},
    events::{CCIPAdminTransferred, CCIPRouterUpdated},
};

/// Mirrors: function setCCIPAdmin(address newAdmin) external onlyRole(ADMIN_ROLE)
///
/// EVM:
///   address currentAdmin = s_ccipAdmin;
///   s_ccipAdmin = newAdmin;
///   emit CCIPAdminTransferred(currentAdmin, newAdmin);
///
/// Note: newAdmin may be Pubkey::default() (= address(0) on EVM) to revoke.
pub fn set_ccip_admin_handler(ctx: Context<SetCCIPAdmin>, new_admin: Pubkey) -> Result<()> {
    let previous_admin = ctx.accounts.token_config.ccip_admin;
    ctx.accounts.token_config.ccip_admin = new_admin;

    emit!(CCIPAdminTransferred {
        previous_admin,
        new_admin,
    });

    Ok(())
}

/// Sets the trusted CCIP router program id used by `pre_bridge_send` to validate
/// the bridge-send instruction window. ADMIN_ROLE gated.
///
/// No EVM parallel — Solana-specific, since the deployed router's address differs
/// per cluster (devnet/mainnet) and per Chainlink deployment, so it can't be
/// hardcoded into the program.
pub fn set_ccip_router_handler(ctx: Context<SetCCIPRouter>, new_router: Pubkey) -> Result<()> {
    let previous_router = ctx.accounts.token_config.ccip_router_program_id;
    ctx.accounts.token_config.ccip_router_program_id = new_router;

    emit!(CCIPRouterUpdated {
        previous_router,
        new_router,
    });

    Ok(())
}
