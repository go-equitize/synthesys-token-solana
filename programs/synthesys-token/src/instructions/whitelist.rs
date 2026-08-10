use anchor_lang::prelude::*;
use anchor_spl::token_interface::{freeze_account, FreezeAccount};

use crate::{
    constants::*,
    context::{AddWhitelist, RemoveWhitelist},
    error::SynthesysTokenError,
    events::{AddressRemovedFromWhitelist, AddressWhitelisted},
    util::freeze_owner_token_accounts,
};

/// Mirrors: function addWhitelistAccount(address account) public onlyRole(ADMIN) in Whitelist.sol
///
/// Creates a WhitelistEntry PDA for `account`. Existence = whitelisted.
/// The token account is left as-is; the user calls thaw_account() to activate it.
///
/// Rejected with `WhitelistNotEnabled` on a blocklist-only mint (`whitelist_enabled == false`)
/// — there is no whitelist to manage there, so we refuse to create meaningless PDAs.
pub fn add_whitelist_handler(ctx: Context<AddWhitelist>, account: Pubkey) -> Result<()> {
    require!(
        ctx.accounts.token_config.whitelist_enabled,
        SynthesysTokenError::WhitelistNotEnabled
    );

    // Anchor's `init` on whitelist_entry already guarantees the PDA doesn't exist yet.
    // Mirrors: require(!_whitelisted[account], AccountAlreadyWhitelisted(account))
    // (enforced by Anchor: init fails if account already exists)

    emit!(AddressWhitelisted { account });
    Ok(())
}

/// Mirrors: function removeWhitelistAccount(address account) public onlyRole(ADMIN) in Whitelist.sol
///
/// Closes the WhitelistEntry PDA. After this, the address can no longer thaw
/// new accounts and their existing token account is frozen immediately.
///
/// Rejected with `WhitelistNotEnabled` on a blocklist-only mint.
pub fn remove_whitelist_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, RemoveWhitelist<'info>>,
    account: Pubkey,
) -> Result<()> {
    require!(
        ctx.accounts.token_config.whitelist_enabled,
        SynthesysTokenError::WhitelistNotEnabled
    );

    // Anchor's `close` on whitelist_entry already verifies the PDA exists.
    // Mirrors: require(_whitelisted[account], AccountNotWhitelisted(account))

    // Guard against freezing an unrelated holder's account: target_token_account is
    // only constrained by token::mint = mint, so nothing else ties it to `account`.
    require_keys_eq!(
        ctx.accounts.target_token_account.owner,
        account,
        SynthesysTokenError::TokenAccountOwnerMismatch
    );

    // Freeze the token account immediately — mirrors the effect of the next
    // _update() call rejecting the de-whitelisted address on EVM.
    let mint_key = ctx.accounts.mint.key();
    let authority_bump = ctx.accounts.token_config.authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        AUTHORITY_SEED,
        mint_key.as_ref(),
        &[authority_bump],
    ]];

    // Only freeze if the account is currently thawed (frozen already is a no-op error).
    use anchor_spl::token_2022::spl_token_2022::state::AccountState;
    if ctx.accounts.target_token_account.state != AccountState::Frozen {
        freeze_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                FreezeAccount {
                    account: ctx.accounts.target_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.authority_pda.to_account_info(),
                },
                signer_seeds,
            ),
        )?;
    }

    // Freeze any sibling token accounts the owner holds for this mint, passed as
    // remaining accounts — otherwise a thaw made while compliant persists on siblings
    // after de-whitelisting and stays movable in the hook-off bridge window.
    freeze_owner_token_accounts(
        ctx.remaining_accounts,
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.authority_pda.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        account,
        authority_bump,
    )?;

    emit!(AddressRemovedFromWhitelist { account });
    Ok(())
}
