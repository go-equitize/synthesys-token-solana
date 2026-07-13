use anchor_lang::prelude::*;
use anchor_spl::token_interface::{mint_to, thaw_account, MintTo, ThawAccount};
use anchor_spl::token_2022::spl_token_2022::state::AccountState;

use crate::{
    constants::*,
    context::MintTokens,
    error::SynthesysTokenError,
    events::TokenMinted,
    util::enforce_whitelist,
};

/// Mirrors: function mint(address account, uint256 amount) public onlyRole(MINTER_ROLE)
///
/// Compliance-gated: checks pause → to-blocklist → (to-whitelist, when whitelist_enabled).
/// If the destination account is frozen but its owner is compliant, thaws it atomically
/// before minting (necessary because Token-2022 blocks mint_to on frozen accounts — unlike
/// EVM where mint goes through _update which checks at runtime).
///
/// EVM _update checks for a mint (from == address(0)):
///   1. if (paused()) revert AllTransfersPaused
///   2. skip from checks (from == 0)
///   3. if (from != msg.sender && to != msg.sender): sender compliance
///   4. to != address(0):  ← always true for mint
///      blocklist.isBlocklisted(to) → revert ToAddressBlocked
///      (whitelist_enabled) !whitelist.isWhitelisted(to) → revert ToAddressNotWhitelisted
pub fn mint_handler(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
    // 1. Pause check — mirrors: if (paused()) revert AllTransfersPaused()
    require!(!ctx.accounts.token_config.paused, SynthesysTokenError::AllTransfersPaused);

    let whitelist_enabled = ctx.accounts.token_config.whitelist_enabled;
    let recipient_owner = ctx.accounts.recipient_token_account.owner;
    let signer_key = ctx.accounts.signer.key();
    let mint_key = ctx.accounts.mint.key();

    // 2. Caller (msg.sender) compliance — mirrors the first branch of _update:
    //    if (from != msg.sender && to != msg.sender) { blocklist(sender); whitelist(sender) }
    //    For a mint, from = address(0), so the branch applies whenever the minter is not
    //    the recipient. Blocklist is checked before whitelist (blocklist takes priority).
    if recipient_owner != signer_key {
        // Blocklist (always). signer_blocklist seeds verified by Anchor.
        require!(
            ctx.accounts.signer_blocklist.data_is_empty(),
            SynthesysTokenError::SenderAddressBlocked
        );
        // Whitelist (only when enabled). Mandatory account when enabled.
        enforce_whitelist(
            whitelist_enabled,
            ctx.program_id,
            &mint_key,
            &signer_key,
            ctx.accounts.signer_whitelist.as_ref(),
            SynthesysTokenError::SenderAddressNotWhitelisted,
        )?;
    }

    // 3. Recipient whitelist (only when enabled).
    //    Mirrors: !whitelist.isWhitelisted(to) → revert ToAddressNotWhitelisted
    enforce_whitelist(
        whitelist_enabled,
        ctx.program_id,
        &mint_key,
        &recipient_owner,
        ctx.accounts.recipient_whitelist.as_ref(),
        SynthesysTokenError::ToAddressNotWhitelisted,
    )?;

    // 4. Recipient blocklist (always). Verify PDA and confirm recipient is NOT blocklisted.
    //    Mirrors: blocklist.isBlocklisted(to) → revert ToAddressBlocked
    let expected_blocklist = Pubkey::find_program_address(
        &[BLOCKLIST_SEED, mint_key.as_ref(), recipient_owner.as_ref()],
        ctx.program_id,
    )
    .0;
    require_keys_eq!(
        ctx.accounts.recipient_blocklist.key(),
        expected_blocklist,
        SynthesysTokenError::InvalidAccountAddress
    );
    require!(
        ctx.accounts.recipient_blocklist.data_is_empty(),
        SynthesysTokenError::ToAddressBlocked
    );

    let authority_bump = ctx.accounts.token_config.authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        AUTHORITY_SEED,
        mint_key.as_ref(),
        &[authority_bump],
    ]];

    // 5. Thaw the account if frozen — Token-2022 blocks mint_to on frozen accounts.
    //    The whitelist/blocklist checks above guarantee this is safe to do.
    if ctx.accounts.recipient_token_account.state == AccountState::Frozen {
        thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            ThawAccount {
                account: ctx.accounts.recipient_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    // 6. Mint tokens.
    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.authority_pda.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    emit!(TokenMinted {
        to: recipient_owner,
        amount,
    });

    Ok(())
}
