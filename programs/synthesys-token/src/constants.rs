use anchor_lang::prelude::*;

/// PDA seeds — each mirrors a concept from the audited EVM contracts.
///
/// TOKEN_CONFIG_SEED   → stores paused, ccip_admin, default_admin, whitelist_enabled
/// WHITELIST_SEED      → per-address PDA; existence = whitelisted  (≈ Whitelist._whitelisted)
/// BLOCKLIST_SEED      → per-address PDA; existence = blocklisted  (≈ Blocklist._blocklisted)
/// ROLE_SEED           → per-(role,address) PDA; existence = has role (≈ AccessControl._roles)
/// AUTHORITY_SEED      → single PDA that holds freeze authority + permanent delegate
/// EXTRA_ACCOUNT_METAS_SEED → standard seed required by spl-transfer-hook-interface

pub const TOKEN_CONFIG_SEED: &[u8] = b"token_config";
pub const WHITELIST_SEED: &[u8] = b"whitelist";
pub const BLOCKLIST_SEED: &[u8] = b"blocklist";
pub const ROLE_SEED: &[u8] = b"role";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Role byte-string seeds.
///
/// On EVM these are keccak256 digests of the same strings:
///   ADMIN_ROLE         = keccak256("ADMIN_ROLE")
///   MINTER_ROLE        = keccak256("MINTER_ROLE")
///   BURNER_ROLE        = keccak256("BURNER_ROLE")
///   DEFAULT_ADMIN_ROLE = bytes32(0)
///
/// On Solana we use the UTF-8 string bytes as PDA seeds. The semantic
/// mapping is 1-to-1 — auditors can verify by name.
pub const ADMIN_ROLE: &[u8] = b"ADMIN_ROLE";
pub const MINTER_ROLE: &[u8] = b"MINTER_ROLE";
pub const BURNER_ROLE: &[u8] = b"BURNER_ROLE";
pub const DEFAULT_ADMIN_ROLE: &[u8] = b"DEFAULT_ADMIN_ROLE";

/// Solana's ComputeBudget program. Legitimate to appear inside a
/// `pre_bridge_send` / `post_bridge_restore` window (e.g. SetComputeUnitLimit for
/// the CCIP send) — it only affects compute metering and cannot move or mint tokens.
pub const COMPUTE_BUDGET_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("ComputeBudget111111111111111111111111111111");

/// Anchor discriminator for the CCIP router's `ccip_send` instruction
/// (sha256("global:ccip_send")[..8], taken from ccip-lib/svm/idl/ccip_router.json).
/// Used to verify the exact instruction allowed to run inside a
/// `pre_bridge_send` / `post_bridge_restore` window — not just "any instruction
/// on the router program."
pub const CCIP_SEND_DISCRIMINATOR: [u8; 8] = [108, 216, 134, 191, 249, 234, 33, 84];
