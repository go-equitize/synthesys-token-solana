use anchor_lang::prelude::*;
use anchor_spl::token_interface::{set_authority, spl_token_2022::instruction::AuthorityType, SetAuthority};

use crate::{constants::*, context::TransferMintAuthority};

/// Transfers the mint authority from our authority_pda to a new address. Generic —
/// `new_mint_authority` can be any Pubkey the caller chooses: a native SPL Multisig
/// (e.g. `[pool_signer_pda, authority_pda]`, so the CCIP burnmint pool can co-sign
/// `mint_to` on inbound transfers while `authority_pda` keeps minting via MINTER_ROLE
/// instructions), a Squads vault PDA, or a plain wallet. This instruction only performs
/// the `SetAuthority` CPI — constructing the new authority account is the caller's
/// responsibility.
///
/// Called once during CCIP pool setup. After this:
///   mintAuthority = new_mint_authority
pub fn transfer_mint_authority_handler(
    ctx: Context<TransferMintAuthority>,
    new_mint_authority: Pubkey,
) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let authority_bump = ctx.accounts.token_config.authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        AUTHORITY_SEED,
        mint_key.as_ref(),
        &[authority_bump],
    ]];

    set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                account_or_mint: ctx.accounts.mint.to_account_info(),
                current_authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ),
        AuthorityType::MintTokens,
        Some(new_mint_authority),
    )?;

    Ok(())
}
