use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        default_account_state::DefaultAccountState, permanent_delegate::PermanentDelegate,
        transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
    },
    state::{AccountState, Mint as SplMint},
};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::{
    constants::*,
    context::{InitExtraAccountMetaList, Initialize},
    error::SynthesysTokenError,
    events::TokenInitialized,
};

/// Sets up governance layer for a pre-created Token-2022 mint.
///
/// The mint must already have:
///   - DefaultAccountState = Frozen
///   - TransferHook = this program ID
///   - PermanentDelegate = authority_pda
///   - FreezeAuthority = authority_pda
///   - MintAuthority = authority_pda (initially; may be transferred to a delegated
///     authority, e.g. a Squads multisig vault, after CCIP pool setup)
///
/// `whitelist_enabled` selects the mint's compliance mode. It is written to
/// `token_config.whitelist_enabled` here and NEVER mutated afterwards — there is no setter
/// instruction — making it an immutable, structural per-mint property (see state::TokenConfig).
pub fn initialize_handler(
    ctx: Context<Initialize>,
    admin: Pubkey,
    ccip_admin: Pubkey,
    whitelist_enabled: bool,
) -> Result<()> {
    // Mirrors: if (admin == address(0)) revert ZeroAddressAdmin();
    require!(admin != Pubkey::default(), SynthesysTokenError::ZeroAddressAdmin);

    // ---- only the program upgrade authority may initialize ----
    // Closes the initialization front-running / takeover window: even if mint creation
    // and initialize() land in separate transactions, an attacker cannot claim admin
    // because they are not the deployer (upgrade authority) of this program.
    require!(
        ctx.accounts.program_data.upgrade_authority_address == Some(ctx.accounts.authority.key()),
        SynthesysTokenError::Unauthorized
    );

    // ---- the mint must actually be configured for compliance ----
    // The entire model depends on DefaultAccountState=Frozen and the three authorities +
    // hook pointing at this program's PDA. Verify on-chain so a misconfigured (or
    // attacker-supplied) mint cannot yield a silently non-compliant token.
    let authority_pda_key = ctx.accounts.authority_pda.key();
    require!(
        ctx.accounts.mint.mint_authority == COption::Some(authority_pda_key),
        SynthesysTokenError::InvalidMintConfiguration
    );
    require!(
        ctx.accounts.mint.freeze_authority == COption::Some(authority_pda_key),
        SynthesysTokenError::InvalidMintConfiguration
    );
    {
        let mint_ai = ctx.accounts.mint.to_account_info();
        let data = mint_ai.try_borrow_data()?;
        let mint_state = StateWithExtensions::<SplMint>::unpack(&data)
            .map_err(|_| error!(SynthesysTokenError::InvalidMintConfiguration))?;

        let default_state = mint_state
            .get_extension::<DefaultAccountState>()
            .map_err(|_| error!(SynthesysTokenError::InvalidMintConfiguration))?;
        require!(
            default_state.state == AccountState::Frozen as u8,
            SynthesysTokenError::InvalidMintConfiguration
        );

        let permanent_delegate = mint_state
            .get_extension::<PermanentDelegate>()
            .map_err(|_| error!(SynthesysTokenError::InvalidMintConfiguration))?;
        require!(
            Option::<Pubkey>::from(permanent_delegate.delegate) == Some(authority_pda_key),
            SynthesysTokenError::InvalidMintConfiguration
        );

        let transfer_hook = mint_state
            .get_extension::<TransferHook>()
            .map_err(|_| error!(SynthesysTokenError::InvalidMintConfiguration))?;
        require!(
            Option::<Pubkey>::from(transfer_hook.program_id) == Some(crate::ID),
            SynthesysTokenError::InvalidMintConfiguration
        );
    }

    let bump = ctx.bumps.token_config;
    let authority_bump = ctx.bumps.authority_pda;

    let config = &mut ctx.accounts.token_config;
    config.mint = ctx.accounts.mint.key();
    config.paused = false;
    config.ccip_admin = ccip_admin;
    config.default_admin = admin;
    config.bypassing_compliance = false;
    // Immutable per-mint compliance mode — set once, here, and never again.
    config.whitelist_enabled = whitelist_enabled;
    config.bump = bump;
    config.authority_bump = authority_bump;
    // `admin` is granted both roles below — starting counts at 1 each keeps the
    // last-holder guard in revoke_role accurate from the very first grant.
    config.default_admin_count = 1;
    config.admin_count = 1;

    emit!(TokenInitialized {
        mint: ctx.accounts.mint.key(),
        admin,
        ccip_admin,
        whitelist_enabled,
    });

    Ok(())
}

/// Creates the ExtraAccountMetaList account used by the Token-2022 transfer hook.
///
/// Must be called ONCE after initialize() and before any token transfers.
///
/// This program ALWAYS registers the full whitelist+blocklist layout (7 extra accounts),
/// regardless of `whitelist_enabled` — this keeps a single fixed account-index layout for
/// the hook so there is no per-mint branching in the `Execute` account ordering. For
/// a blocklist-only mint the whitelist PDAs are still resolved and passed to the hook, which
/// simply never reads them. This keeps a single fixed account-index layout for the hook:
///   [0] token_config        — static PDA for pause state + whitelist_enabled
///   [1] from_whitelist       — dynamic PDA from source-account owner
///   [2] from_blocklist       — dynamic PDA from source-account owner
///   [3] to_whitelist         — dynamic PDA from destination-account owner
///   [4] to_blocklist         — dynamic PDA from destination-account owner
///   [5] authority_whitelist  — dynamic PDA from transfer authority
///   [6] authority_blocklist  — dynamic PDA from transfer authority
///
/// Standard account indices passed by Token-2022 to the hook:
///   0 = source_token_account
///   1 = mint
///   2 = destination_token_account
///   3 = authority (owner or delegate)
///   4+ = extra accounts (registered below)
pub fn initialize_extra_account_meta_list_handler(
    ctx: Context<InitExtraAccountMetaList>,
) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();

    // Derive the static token_config PDA address upfront.
    let (token_config_pda, _) = Pubkey::find_program_address(
        &[TOKEN_CONFIG_SEED, mint_key.as_ref()],
        ctx.program_id,
    );

    // Build the ExtraAccountMeta entries. Token-2022 resolves these and passes them to
    // the hook so it can enforce full EVM `_update` parity: from-owner, to-owner, AND the
    // caller/delegate are all checked. The `from`/`to` PDAs are derived from the OWNER
    // field (bytes 32..64) of the source (index 0) and destination (index 2) token
    // accounts — this is what closes the multi-token-account compliance bypass, since
    // freeze state alone cannot represent per-owner compliance.
    //
    // Owner-field seed: source/destination SPL token account layout is
    //   mint[0..32], owner[32..64], amount[64..72], ...
    let owner_seed = |token_account_index: u8| Seed::AccountData {
        account_index: token_account_index,
        data_index: 32,
        length: 32,
    };
    let account_metas = vec![
        // [0] token_config — static address (pre-derived)
        ExtraAccountMeta::new_with_pubkey(&token_config_pda, false, false)
            .map_err(|_| error!(SynthesysTokenError::ExtraAccountMetaListError))?,

        // [1] from_whitelist — [WHITELIST_SEED, mint (index 1), source_owner (data of index 0)]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: WHITELIST_SEED.to_vec() },
                Seed::AccountKey { index: 1 },
                owner_seed(0),
            ],
            false,
            false,
        )
        .map_err(|_| error!(SynthesysTokenError::ExtraAccountMetaListError))?,

        // [2] from_blocklist — same but BLOCKLIST_SEED
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: BLOCKLIST_SEED.to_vec() },
                Seed::AccountKey { index: 1 },
                owner_seed(0),
            ],
            false,
            false,
        )
        .map_err(|_| error!(SynthesysTokenError::ExtraAccountMetaListError))?,

        // [3] to_whitelist — [WHITELIST_SEED, mint (index 1), dest_owner (data of index 2)]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: WHITELIST_SEED.to_vec() },
                Seed::AccountKey { index: 1 },
                owner_seed(2),
            ],
            false,
            false,
        )
        .map_err(|_| error!(SynthesysTokenError::ExtraAccountMetaListError))?,

        // [4] to_blocklist — same but BLOCKLIST_SEED
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: BLOCKLIST_SEED.to_vec() },
                Seed::AccountKey { index: 1 },
                owner_seed(2),
            ],
            false,
            false,
        )
        .map_err(|_| error!(SynthesysTokenError::ExtraAccountMetaListError))?,

        // [5] authority_whitelist — [WHITELIST_SEED, mint (index 1), authority (index 3)]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: WHITELIST_SEED.to_vec() },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 3 },
            ],
            false,
            false,
        )
        .map_err(|_| error!(SynthesysTokenError::ExtraAccountMetaListError))?,

        // [6] authority_blocklist — same but BLOCKLIST_SEED
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: BLOCKLIST_SEED.to_vec() },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 3 },
            ],
            false,
            false,
        )
        .map_err(|_| error!(SynthesysTokenError::ExtraAccountMetaListError))?,
    ];

    // Compute exact space needed for the TLV-encoded list.
    let space = ExtraAccountMetaList::size_of(account_metas.len())
        .map_err(|_| error!(SynthesysTokenError::ArithmeticOverflow))?;

    // Create the raw account owned by this program via system program CPI.
    // (Cannot use Anchor's `init` here because the account is NOT an Anchor account
    //  — it uses the spl-tlv-account-resolution binary format, not the Anchor discriminator.)
    let bump = ctx.bumps.extra_account_meta_list;
    let signer_seeds: &[&[&[u8]]] = &[&[
        EXTRA_ACCOUNT_METAS_SEED,
        mint_key.as_ref(),
        &[bump],
    ]];

    // Pre-fund-safe creation (see util::create_managed_pda) — a griefer cannot brick
    // hook initialization by pre-sending lamports to this deterministic PDA.
    crate::util::create_managed_pda(
        &ctx.accounts.extra_account_meta_list.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        space,
        ctx.program_id,
        signer_seeds,
    )?;

    // Initialize the account with TLV-encoded ExtraAccountMetaList data.
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
        &account_metas,
    )
    .map_err(|_| error!(SynthesysTokenError::ExtraAccountMetaListError))?;

    Ok(())
}
