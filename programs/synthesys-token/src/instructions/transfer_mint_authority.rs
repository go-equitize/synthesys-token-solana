use anchor_lang::prelude::*;
use anchor_spl::token_interface::{set_authority, spl_token_2022::instruction::AuthorityType, SetAuthority};

use crate::{
    constants::*,
    context::{AcceptMintAuthority, ProposeMintAuthority, TransferMintAuthority},
    error::SynthesysTokenError,
    events::{MintAuthorityProposed, MintAuthorityTransferred},
};

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
    // The handoff is irreversible once authority_pda no longer holds MintTokens; reject an
    // obviously-wrong zero destination that would orphan minting entirely.
    require!(
        new_mint_authority != Pubkey::default(),
        SynthesysTokenError::InvalidZeroAddress
    );

    let mint_key = ctx.accounts.mint.key();
    let authority_pda_key = ctx.accounts.authority_pda.key();
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

    emit!(MintAuthorityTransferred {
        mint: mint_key,
        previous_authority: authority_pda_key,
        new_authority: new_mint_authority,
    });

    Ok(())
}

/// Two-step handoff, step 1: an ADMIN nominates `candidate` as the incoming mint authority.
/// The authority does NOT move here — `authority_pda` keeps MintTokens until `candidate`
/// confirms via `accept_mint_authority`, so a mistyped destination is fully recoverable
/// (just re-propose). Use this path for destinations that can sign (plain wallet, Squads
/// vault); use the one-step `transfer_mint_authority` for a PDA pool signer that cannot.
pub fn propose_mint_authority_handler(
    ctx: Context<ProposeMintAuthority>,
    candidate: Pubkey,
) -> Result<()> {
    require!(
        candidate != Pubkey::default(),
        SynthesysTokenError::InvalidZeroAddress
    );

    ctx.accounts.token_config.pending_mint_authority = Some(candidate);

    emit!(MintAuthorityProposed {
        mint: ctx.accounts.mint.key(),
        candidate,
    });

    Ok(())
}

/// Two-step handoff, step 2: the pending candidate signs to claim the mint authority.
/// Verifies the signer is exactly the proposed candidate, then signs the SetAuthority CPI
/// from `authority_pda` and clears the pending slot. Because the recipient had to sign,
/// a wrong destination can never end up holding MintTokens.
pub fn accept_mint_authority_handler(ctx: Context<AcceptMintAuthority>) -> Result<()> {
    let candidate_key = ctx.accounts.candidate.key();
    require!(
        ctx.accounts.token_config.pending_mint_authority == Some(candidate_key),
        SynthesysTokenError::NotPendingMintAuthority
    );

    let mint_key = ctx.accounts.mint.key();
    let authority_pda_key = ctx.accounts.authority_pda.key();
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
        Some(candidate_key),
    )?;

    ctx.accounts.token_config.pending_mint_authority = None;

    emit!(MintAuthorityTransferred {
        mint: mint_key,
        previous_authority: authority_pda_key,
        new_authority: candidate_key,
    });

    Ok(())
}
