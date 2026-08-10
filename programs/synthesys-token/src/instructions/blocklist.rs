use anchor_lang::prelude::*;
use anchor_spl::token_interface::{freeze_account, FreezeAccount};
use anchor_spl::token_2022::spl_token_2022::state::AccountState;

use crate::{
    constants::*,
    context::{AddBlocklist, RemoveBlocklist},
    error::SynthesysTokenError,
    events::{AddressBlocklisted, AddressRemovedFromBlocklist},
    util::freeze_owner_token_accounts,
};

/// Mirrors: function addBlocklistAccount(address account) public onlyRole(ADMIN) in Blocklist.sol
///
/// Creates a BlocklistEntry PDA and immediately freezes the token account.
/// On EVM, the blocklist check is enforced at the next _update() call.
/// On Solana, we freeze immediately for equivalent real-time enforcement.
///
/// Blocklist enforcement is identical regardless of `whitelist_enabled`.
pub fn add_blocklist_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, AddBlocklist<'info>>,
    account: Pubkey,
) -> Result<()> {
    // Anchor's `init` ensures the blocklist PDA does not already exist.
    // Mirrors: require(!_blocklisted[account], AccountAlreadyBlocklisted(account))

    // Guard against freezing an unrelated holder's account: target_token_account is
    // only constrained by token::mint = mint, so nothing else ties it to `account`.
    require_keys_eq!(
        ctx.accounts.target_token_account.owner,
        account,
        SynthesysTokenError::TokenAccountOwnerMismatch
    );

    let mint_key = ctx.accounts.mint.key();
    let authority_bump = ctx.accounts.token_config.authority_bump;

    // Freeze the token account immediately.
    // Already-frozen accounts are a no-op; we skip if already frozen.
    if ctx.accounts.target_token_account.state != AccountState::Frozen {
        let signer_seeds: &[&[&[u8]]] = &[&[
            AUTHORITY_SEED,
            mint_key.as_ref(),
            &[authority_bump],
        ]];

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
    // remaining accounts — the owner-keyed blocklist must cover all of them.
    freeze_owner_token_accounts(
        ctx.remaining_accounts,
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.authority_pda.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        account,
        authority_bump,
    )?;

    emit!(AddressBlocklisted { account });
    Ok(())
}

/// Mirrors: function removeBlocklistAccount(address account) public onlyRole(ADMIN) in Blocklist.sol
///
/// Closes the BlocklistEntry PDA. Does NOT automatically thaw the account.
/// The user must call thaw_account() after this (which re-checks compliance).
/// This mirrors EVM behaviour: removal from blocklist alone does not restore transfers —
/// on a whitelisted mint the whitelist must also be satisfied.
pub fn remove_blocklist_handler(_ctx: Context<RemoveBlocklist>, account: Pubkey) -> Result<()> {
    // Anchor's `close` verifies the PDA exists.
    // Mirrors: require(_blocklisted[account], AccountNotBlocklisted(account))

    emit!(AddressRemovedFromBlocklist { account });
    Ok(())
}
