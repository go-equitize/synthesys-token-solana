//! # synthesys-token
//!
//! Compliant Token-2022 program with a **per-mint, immutable whitelist switch**.
//!
//! This program is the union of the two audited siblings in this workspace:
//!   - `rwa-token` — whitelist + blocklist (fully permissioned)
//!   - `z-token`   — blocklist only (semi-permissioned)
//!
//! Instead of shipping two programs, a single mint chooses its compliance mode ONCE at
//! `initialize()` via the `whitelist_enabled` flag, which is then **never mutable again**
//! (there is no setter instruction). A mint is therefore permanently either:
//!   - `whitelist_enabled = true`  → rwa-token semantics; whitelist PDAs are mandatory
//!   - `whitelist_enabled = false` → z-token semantics; blocklist-only
//!
//! Blocklist and pause enforcement are identical in both modes. Only the whitelist checks
//! and whitelist-account requirements are gated on the flag.
//!
//! ## Architecture
//!
//! ```text
//! Token-2022 Mint (pre-created externally)
//!   ├── DefaultAccountState = Frozen          ← new accounts start frozen (both modes)
//!   ├── TransferHook       = THIS program      ← pause + compliance
//!   ├── PermanentDelegate  = authority_pda     ← forceBurn / forcedTransfer
//!   ├── FreezeAuthority    = authority_pda     ← whitelist / blocklist enforcement
//!   └── MintAuthority      = authority_pda     ← initial; may later be transferred to a
//!                                                 delegated authority (e.g. a Squads
//!                                                 multisig vault co-signed by the CCIP
//!                                                 pool signer) after CCIP pool setup
//!
//! Program PDAs:
//!   token_config[mint]        ← paused, ccip_admin, default_admin, whitelist_enabled, ...
//!   whitelist[mint][address]  ← existence = whitelisted (only when whitelist_enabled)
//!   blocklist[mint][address]  ← existence = blocklisted
//!   role[mint][role][address] ← existence = has role
//!   authority[mint]           ← freeze_authority + permanent_delegate
//!   extra-account-metas[mint] ← transfer hook account list (spl-transfer-hook-interface)
//! ```
//!
//! ## EVM → Solana mapping
//!
//! | EVM | Solana |
//! |---|---|
//! | `whitelist.isWhitelisted(addr)` | whitelist PDA exists (whitelist_enabled only) |
//! | `blocklist.isBlocklisted(addr)` | blocklist PDA exists |
//! | `paused()` | `token_config.paused` |
//! | `onlyRole(X)` | role PDA exists at `[ROLE_SEED, mint, X, signer]` |
//! | `forceBurn` bypass | thaw → burn (no hook on burn) → re-freeze |
//! | `forcedTransfer` bypass | thaw → burn(from) + mint_to(to) (no hook on burn/mint) → re-freeze |
//! | `_approve` compliance gate | `approve` instruction wrapper |
//!
//! ## CCIP integration
//!
//! 1. Deploy program, create Token-2022 mint with required extensions.
//! 2. Call `initialize_extra_account_meta_list`.
//! 3. Call `initialize` (choosing `whitelist_enabled`).
//! 4. If whitelisted: add CCIP fee-billing signer PDA and pool signer PDA to whitelist.
//! 5. Optionally transfer mint authority to a delegated authority (e.g. a Squads vault,
//!    or a native SPL Multisig co-signed by the CCIP pool signer).
//! 6. Follow the remaining CCIP pool setup scripts.

#![allow(unexpected_cfgs)]
// The Anchor program module is named `SynthesysToken` (PascalCase) to match the naming
// convention used by the sibling programs; this is intentionally non-snake-case.
#![allow(non_snake_case)]

use anchor_lang::prelude::*;

mod constants;
mod context;
mod error;
mod events;
mod instructions;
mod state;
mod util;

use context::*;
use instructions::*;

// IMPORTANT: Replace with real program ID after first `anchor build` or
// `anchor keys sync`. Generated fresh for this program.
declare_id!("7rCrfZnJakWfGfUmHovVGWFvwxnELfxnXzebmatjXeHp");

#[program]
pub mod SynthesysToken {
    use super::*;

    /// Sets up governance layer for a pre-created Token-2022 mint.
    /// Mirrors: function initialize(...) public initializer
    ///
    /// `whitelist_enabled` is the immutable per-mint compliance mode (see state::TokenConfig).
    pub fn initialize(
        ctx: Context<Initialize>,
        admin: Pubkey,
        ccip_admin: Pubkey,
        whitelist_enabled: bool,
    ) -> Result<()> {
        initialize_handler(ctx, admin, ccip_admin, whitelist_enabled)
    }

    /// Creates the ExtraAccountMetaList PDA used by the Token-2022 transfer hook.
    /// Must be called once after initialize() and before any transfers.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitExtraAccountMetaList>,
    ) -> Result<()> {
        initialize_extra_account_meta_list_handler(ctx)
    }

    /// Mirrors: addWhitelistAccount(address account)
    /// Rejected with `WhitelistNotEnabled` when the mint has whitelist disabled.
    pub fn add_whitelist(ctx: Context<AddWhitelist>, account: Pubkey) -> Result<()> {
        add_whitelist_handler(ctx, account)
    }

    /// Mirrors: removeWhitelistAccount(address account)
    /// Rejected with `WhitelistNotEnabled` when the mint has whitelist disabled.
    pub fn remove_whitelist(ctx: Context<RemoveWhitelist>, account: Pubkey) -> Result<()> {
        remove_whitelist_handler(ctx, account)
    }

    /// Mirrors: addBlocklistAccount(address account)
    pub fn add_blocklist(ctx: Context<AddBlocklist>, account: Pubkey) -> Result<()> {
        add_blocklist_handler(ctx, account)
    }

    /// Mirrors: removeBlocklistAccount(address account)
    pub fn remove_blocklist(ctx: Context<RemoveBlocklist>, account: Pubkey) -> Result<()> {
        remove_blocklist_handler(ctx, account)
    }

    /// Mirrors: mint(address account, uint256 amount)
    pub fn mint(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        mint_handler(ctx, amount)
    }

    /// Mirrors: burn(uint256 amount) — signer burns from own account.
    pub fn burn_self(ctx: Context<BurnSelf>, amount: u64) -> Result<()> {
        burn_self_handler(ctx, amount)
    }

    /// Mirrors: burn(address account, uint256 amount) — burn from any account via permanent delegate.
    pub fn burn_account(ctx: Context<BurnAccount>, amount: u64) -> Result<()> {
        burn_account_handler(ctx, amount)
    }

    /// Mirrors: burnFrom(address account, uint256 amount) — burn via user-granted delegation.
    pub fn burn_from(ctx: Context<BurnFrom>, amount: u64) -> Result<()> {
        burn_from_handler(ctx, amount)
    }

    /// Mirrors: forceBurn(address account, uint256 amount)
    pub fn force_burn(ctx: Context<ForceBurnTokens>, amount: u64) -> Result<()> {
        force_burn_handler(ctx, amount)
    }

    /// Mirrors: forcedTransfer(address from, address to, uint256 amount)
    pub fn forced_transfer(ctx: Context<ForcedTransfer>, amount: u64) -> Result<()> {
        forced_transfer_handler(ctx, amount)
    }

    /// Mirrors: pause()
    pub fn pause(ctx: Context<SetPause>) -> Result<()> {
        pause_handler(ctx)
    }

    /// Mirrors: unpause()
    pub fn unpause(ctx: Context<SetPause>) -> Result<()> {
        unpause_handler(ctx)
    }

    /// Mirrors: grantRole(bytes32 role, address account)
    pub fn grant_role(ctx: Context<GrantRole>, role: String, grantee: Pubkey) -> Result<()> {
        grant_role_handler(ctx, role, grantee)
    }

    /// Mirrors: revokeRole(bytes32 role, address account)
    pub fn revoke_role(ctx: Context<RevokeRole>, role: String, grantee: Pubkey) -> Result<()> {
        revoke_role_handler(ctx, role, grantee)
    }

    /// Mirrors: setCCIPAdmin(address newAdmin)
    pub fn set_ccip_admin(ctx: Context<SetCCIPAdmin>, new_admin: Pubkey) -> Result<()> {
        set_ccip_admin_handler(ctx, new_admin)
    }

    /// Sets the trusted CCIP router program id used to validate the
    /// pre_bridge_send / post_bridge_restore instruction window. ADMIN_ROLE gated.
    pub fn set_ccip_router(ctx: Context<SetCCIPRouter>, new_router: Pubkey) -> Result<()> {
        set_ccip_router_handler(ctx, new_router)
    }

    /// Transfers mint authority from our authority_pda to any new authority.
    /// Generic — accepts any Pubkey, so the caller decides what governs minting after
    /// this call: a native SPL Multisig (e.g. co-signed by the CCIP pool signer, so CCIP
    /// can mint on inbound transfers), a Squads vault PDA, or a plain wallet.
    ///
    /// ADMIN_ROLE-gated. This instruction performs the transfer directly from our PDA.
    ///
    /// After this call:
    ///   mintAuthority = new_mint_authority
    pub fn transfer_mint_authority(
        ctx: Context<TransferMintAuthority>,
        new_mint_authority: Pubkey,
    ) -> Result<()> {
        transfer_mint_authority_handler(ctx, new_mint_authority)
    }

    /// Opens a compliance-checked, atomically-paired window during which the
    /// transfer hook is disabled so the deployed CCIP router can move the caller's
    /// tokens into pool custody. Permissionless (compliance-gated, not
    /// ADMIN_ROLE-gated) — any compliant (whitelisted-if-enabled, non-blocklisted) user
    /// can self-serve bridge. Must be paired with `post_bridge_restore` later in the same
    /// transaction, with only ComputeBudget/ccip_send instructions in between —
    /// enforced via instruction introspection so the hook can never be left
    /// disabled and the window can't be used to sandwich an unrelated transfer.
    pub fn pre_bridge_send(ctx: Context<PreBridgeSend>) -> Result<()> {
        pre_bridge_send_handler(ctx)
    }

    /// Restores the transfer hook disabled by `pre_bridge_send`.
    pub fn post_bridge_restore(ctx: Context<PostBridgeRestore>) -> Result<()> {
        post_bridge_restore_handler(ctx)
    }

    /// Permissionless thaw — activates a frozen token account for a compliant owner.
    /// Must be called by users before they can receive tokens via CCIP or direct mint.
    pub fn thaw_token_account(ctx: Context<ThawTokenAccount>) -> Result<()> {
        thaw_token_account_handler(ctx)
    }

    /// Compliance-gated approve — mirrors _approve() override.
    /// Users may still call Token-2022 approve directly; the transfer hook compensates.
    pub fn approve_tokens(ctx: Context<ApproveTokens>, amount: u64) -> Result<()> {
        approve_handler(ctx, amount)
    }

    /// Routes the spl-transfer-hook-interface Execute CPI to our compliance handler.
    ///
    /// Token-2022 CPIs into this program on every `transfer_checked` for mints
    /// with this program set as their TransferHook extension.  Anchor 0.31 cannot
    /// register a foreign discriminator via `#[interface]` inside `#[program]`,
    /// so we use the named `fallback` hook — Anchor calls it for any instruction
    /// discriminator that doesn't match a known Anchor instruction.
    ///
    /// Mirrors: function _update(address from, address to, uint256 value) internal override
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        use spl_transfer_hook_interface::instruction::TransferHookInstruction;

        match TransferHookInstruction::unpack(data)
            .map_err(|_| ProgramError::InvalidInstructionData)?
        {
            TransferHookInstruction::Execute { amount } => {
                let mut bumps = ExecuteBumps::default();
                let mut reallocs = std::collections::BTreeSet::new();
                let mut remaining = accounts;
                let mut ctx_accounts = Execute::try_accounts(
                    program_id,
                    &mut remaining,
                    data,
                    &mut bumps,
                    &mut reallocs,
                )?;
                execute_transfer_hook(
                    Context::new(program_id, &mut ctx_accounts, remaining, bumps),
                    amount,
                )
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}
