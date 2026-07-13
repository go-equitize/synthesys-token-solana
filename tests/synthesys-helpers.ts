import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SynthesysToken } from "../target/types/SynthesysToken";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getMintLen,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeTransferHookInstruction,
  createInitializeMintCloseAuthorityInstruction,
  AccountState,
  unpackAccount,
  createTransferCheckedWithTransferHookInstruction,
} from "@solana/spl-token";

/** Token-2022 account fetch that tolerates extensions. */
export async function getTokenAccount(
  connection: anchor.web3.Connection,
  address: PublicKey,
) {
  const info = await connection.getAccountInfo(address);
  if (!info) throw new Error(`Account ${address.toBase58()} not found`);
  return unpackAccount(address, info, TOKEN_2022_PROGRAM_ID);
}

// PDA seed helpers — must match programs/synthesys-token/src/constants.rs exactly.
export const TOKEN_CONFIG_SEED = Buffer.from("token_config");
export const WHITELIST_SEED = Buffer.from("whitelist");
export const BLOCKLIST_SEED = Buffer.from("blocklist");
export const ROLE_SEED = Buffer.from("role");
export const AUTHORITY_SEED = Buffer.from("authority");
export const EXTRA_ACCOUNT_METAS_SEED = Buffer.from("extra-account-metas");

export const ADMIN_ROLE = Buffer.from("ADMIN_ROLE");
export const MINTER_ROLE = Buffer.from("MINTER_ROLE");
export const BURNER_ROLE = Buffer.from("BURNER_ROLE");
export const DEFAULT_ADMIN_ROLE = Buffer.from("DEFAULT_ADMIN_ROLE");

export function findPDA(seeds: Buffer[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

export function whitelistPda(mint: PublicKey, owner: PublicKey, programId: PublicKey): PublicKey {
  return findPDA([WHITELIST_SEED, mint.toBuffer(), owner.toBuffer()], programId)[0];
}
export function blocklistPda(mint: PublicKey, owner: PublicKey, programId: PublicKey): PublicKey {
  return findPDA([BLOCKLIST_SEED, mint.toBuffer(), owner.toBuffer()], programId)[0];
}
export function rolePda(mint: PublicKey, role: Buffer, key: PublicKey, programId: PublicKey): PublicKey {
  return findPDA([ROLE_SEED, mint.toBuffer(), role, key.toBuffer()], programId)[0];
}

/**
 * Build a transfer_checked instruction, resolving the mint's on-chain
 * ExtraAccountMetaList (token_config + from/to/authority whitelist+blocklist PDAs).
 * Works identically whether or not the mint enables whitelist — the resolved layout is
 * fixed; the hook simply ignores the whitelist slots for blocklist-only mints.
 */
export async function buildTransferWithHookIx(
  connection: anchor.web3.Connection,
  sourceATA: PublicKey,
  mintKey: PublicKey,
  destATA: PublicKey,
  authority: PublicKey,
  amount: bigint,
  decimals: number,
): Promise<TransactionInstruction> {
  return createTransferCheckedWithTransferHookInstruction(
    connection,
    sourceATA,
    mintKey,
    destATA,
    authority,
    amount,
    decimals,
    [],
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
}

/** Create a Token-2022 mint pre-wired for this program (Frozen default, hook + authorities = authority_pda). */
export async function createSynthesysMint(
  provider: anchor.AnchorProvider,
  admin: anchor.web3.Keypair,
  programId: PublicKey,
): Promise<Keypair> {
  const mintKeypair = Keypair.generate();
  const mintPubkey = mintKeypair.publicKey;
  const [authPda] = findPDA([AUTHORITY_SEED, mintPubkey.toBuffer()], programId);

  const extensions = [
    ExtensionType.PermanentDelegate,
    ExtensionType.DefaultAccountState,
    ExtensionType.TransferHook,
    ExtensionType.MintCloseAuthority,
  ];
  const mintLen = getMintLen(extensions);
  const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new anchor.web3.Transaction();
  tx.add(SystemProgram.createAccount({
    fromPubkey: admin.publicKey,
    newAccountPubkey: mintPubkey,
    space: mintLen,
    lamports,
    programId: TOKEN_2022_PROGRAM_ID,
  }));
  tx.add(createInitializeMintCloseAuthorityInstruction(mintPubkey, authPda, TOKEN_2022_PROGRAM_ID));
  tx.add(createInitializePermanentDelegateInstruction(mintPubkey, authPda, TOKEN_2022_PROGRAM_ID));
  tx.add(createInitializeDefaultAccountStateInstruction(mintPubkey, AccountState.Frozen, TOKEN_2022_PROGRAM_ID));
  tx.add(createInitializeTransferHookInstruction(mintPubkey, authPda, programId, TOKEN_2022_PROGRAM_ID));
  tx.add(createInitializeMintInstruction(mintPubkey, 6, authPda, authPda, TOKEN_2022_PROGRAM_ID));

  await provider.sendAndConfirm(tx, [admin, mintKeypair]);
  return mintKeypair;
}

export async function createATA(
  provider: anchor.AnchorProvider,
  admin: anchor.web3.Keypair,
  user: PublicKey,
  mintPubkey: PublicKey,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mintPubkey, user, false, TOKEN_2022_PROGRAM_ID);
  const existing = await provider.connection.getAccountInfo(ata);
  if (existing) return ata;
  const ix = createAssociatedTokenAccountInstruction(admin.publicKey, ata, user, mintPubkey, TOKEN_2022_PROGRAM_ID);
  await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [admin]);
  return ata;
}

/**
 * One compliance mode = one fully-initialized mint plus every governance PDA the tests
 * need. Two of these are created (whitelist enabled / disabled) and the shared test
 * batteries run against both.
 */
export interface Mode {
  label: string;
  whitelistEnabled: boolean;
  mint: Keypair;
  tokenConfig: PublicKey;
  authorityPda: PublicKey;
  authorityBump: number;
  extraAccountMetaList: PublicKey;
  adminRolePda: PublicKey;
  minterRolePda: PublicKey;
  burnerRolePda: PublicKey;
  defaultAdminRolePda: PublicKey;
  adminWl: PublicKey;
  adminBl: PublicKey;
}

export interface Ctx {
  program: Program<SynthesysToken>;
  provider: anchor.AnchorProvider;
  connection: anchor.web3.Connection;
  admin: anchor.web3.Keypair;
  programId: PublicKey;
  on: Mode;   // whitelist_enabled = true
  off: Mode;  // whitelist_enabled = false
  // pre-funded (SOL) keypairs shared across suites
  alice: Keypair;
  bob: Keypair;
  carol: Keypair;
  delegate: Keypair;
  outsider: Keypair;   // never whitelisted
  blocked: Keypair;    // gets blocklisted
  mallory: Keypair;    // non-admin attacker
}
