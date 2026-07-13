/**
 * Shared fixtures for the synthesys-token suite, split across tests/synthesys-token/*.spec.ts.
 *
 * `getCtx()` lazily builds the two mints (whitelist enabled / disabled) exactly once —
 * the returned promise is memoized at module scope, so every spec file that imports this
 * module and calls `getCtx()` in its own `before()` shares the SAME setup, run only by
 * whichever spec file's before() hook resolves it first. This relies on Node's module
 * cache (one process, files run sequentially) — do not run these spec files in separate
 * mocha worker processes.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SynthesysToken } from "../../target/types/SynthesysToken";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  Ctx,
  Mode,
  findPDA,
  getTokenAccount,
  createSynthesysMint,
  createATA,
  whitelistPda,
  blocklistPda,
  rolePda,
  TOKEN_CONFIG_SEED,
  AUTHORITY_SEED,
  EXTRA_ACCOUNT_METAS_SEED,
  ADMIN_ROLE,
  MINTER_ROLE,
  BURNER_ROLE,
  DEFAULT_ADMIN_ROLE,
} from "../synthesys-helpers";

const baseProvider = anchor.AnchorProvider.env();
export const provider = new anchor.AnchorProvider(
  baseProvider.connection,
  baseProvider.wallet,
  { commitment: "confirmed", preflightCommitment: "confirmed" },
);
anchor.setProvider(provider);

export const program = anchor.workspace.SynthesysToken as Program<SynthesysToken>;
export const programId = program.programId;
export const connection = provider.connection;
export const admin = (provider.wallet as anchor.Wallet).payer;

export const alice = Keypair.generate();
export const bob = Keypair.generate();
export const carol = Keypair.generate();
export const delegate = Keypair.generate();
export const outsider = Keypair.generate();
export const blocked = Keypair.generate();
export const mallory = Keypair.generate();

// ---- shared low-level helpers (mirror the original suite's inline helpers) -------------

/** Optional whitelist account value: the PDA when the mode enables whitelist, else null (None). */
export const wlOpt = (mode: Mode, owner: PublicKey): PublicKey | null =>
  mode.whitelistEnabled ? whitelistPda(mode.mint.publicKey, owner, programId) : null;

export const bl = (mode: Mode, owner: PublicKey) => blocklistPda(mode.mint.publicKey, owner, programId);

export async function addWhitelist(mode: Mode, owner: PublicKey) {
  await program.methods
    .addWhitelist(owner)
    .accounts({
      authority: admin.publicKey,
      payer: admin.publicKey,
      roleEntry: mode.adminRolePda,
      tokenConfig: mode.tokenConfig,
      mint: mode.mint.publicKey,
      whitelistEntry: whitelistPda(mode.mint.publicKey, owner, programId),
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
}

export async function addBlocklist(mode: Mode, owner: PublicKey, ata: PublicKey) {
  await program.methods
    .addBlocklist(owner)
    .accounts({
      authority: admin.publicKey,
      payer: admin.publicKey,
      roleEntry: mode.adminRolePda,
      tokenConfig: mode.tokenConfig,
      mint: mode.mint.publicKey,
      blocklistEntry: bl(mode, owner),
      authorityPda: mode.authorityPda,
      targetTokenAccount: ata,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
}

export async function removeBlocklist(mode: Mode, owner: PublicKey) {
  await program.methods
    .removeBlocklist(owner)
    .accounts({
      authority: admin.publicKey,
      payer: admin.publicKey,
      roleEntry: mode.adminRolePda,
      tokenConfig: mode.tokenConfig,
      mint: mode.mint.publicKey,
      blocklistEntry: bl(mode, owner),
    } as any)
    .rpc();
}

/** Mint `amount` to `owner` (admin is the minter). Creates the ATA and auto-thaws it. */
export async function mintTo(mode: Mode, owner: PublicKey, amount: number) {
  const ata = await createATA(provider, admin, owner, mode.mint.publicKey);
  await program.methods
    .mint(new anchor.BN(amount))
    .accounts({
      signer: admin.publicKey,
      roleEntry: mode.minterRolePda,
      tokenConfig: mode.tokenConfig,
      mint: mode.mint.publicKey,
      recipientTokenAccount: ata,
      recipientWhitelist: wlOpt(mode, owner),
      recipientBlocklist: bl(mode, owner),
      signerWhitelist: wlOpt(mode, admin.publicKey),
      signerBlocklist: mode.adminBl,
      authorityPda: mode.authorityPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    } as any)
    .rpc();
  return ata;
}

/** Ensure `owner` holds at least `min` tokens on `mode` (whitelisting them first when enabled). */
export async function ensureFunded(mode: Mode, ownerKp: Keypair, min: number) {
  if (mode.whitelistEnabled) {
    const wl = whitelistPda(mode.mint.publicKey, ownerKp.publicKey, programId);
    if (!(await connection.getAccountInfo(wl))) await addWhitelist(mode, ownerKp.publicKey);
  }
  const ata = getAssociatedTokenAddressSync(mode.mint.publicKey, ownerKp.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const info = await connection.getAccountInfo(ata);
  const balance = info ? Number((await getTokenAccount(connection, ata)).amount) : 0;
  if (balance < min) await mintTo(mode, ownerKp.publicKey, min - balance);
  return ata;
}

export async function expectRevert(p: Promise<any>, needle: RegExp | string) {
  try {
    await p;
    expect.fail("expected the instruction to revert, but it succeeded");
  } catch (e: any) {
    const msg = (e.message ?? e.toString()) + JSON.stringify(e.logs ?? []);
    if (needle instanceof RegExp) expect(msg).to.match(needle);
    else expect(msg).to.include(needle);
  }
}

async function setupMode(whitelistEnabled: boolean, label: string): Promise<Mode> {
  const mint = await createSynthesysMint(provider, admin, programId);
  const m = mint.publicKey;
  const [tokenConfig] = findPDA([TOKEN_CONFIG_SEED, m.toBuffer()], programId);
  const [authorityPda, authorityBump] = findPDA([AUTHORITY_SEED, m.toBuffer()], programId);
  const [extraAccountMetaList] = findPDA([EXTRA_ACCOUNT_METAS_SEED, m.toBuffer()], programId);
  const adminRolePda = rolePda(m, ADMIN_ROLE, admin.publicKey, programId);
  const minterRolePda = rolePda(m, MINTER_ROLE, admin.publicKey, programId);
  const burnerRolePda = rolePda(m, BURNER_ROLE, admin.publicKey, programId);
  const defaultAdminRolePda = rolePda(m, DEFAULT_ADMIN_ROLE, admin.publicKey, programId);

  await program.methods
    .initialize(admin.publicKey, admin.publicKey, whitelistEnabled)
    .accounts({
      authority: admin.publicKey,
      payer: admin.publicKey,
      mint: m,
      tokenConfig,
      adminRoleEntry: adminRolePda,
      minterRoleEntry: minterRolePda,
      burnerRoleEntry: burnerRolePda,
      defaultAdminRoleEntry: defaultAdminRolePda,
      authorityPda,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  await program.methods
    .initializeExtraAccountMetaList()
    .accounts({
      authority: admin.publicKey,
      payer: admin.publicKey,
      roleEntry: adminRolePda,
      tokenConfig,
      mint: m,
      extraAccountMetaList,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  return {
    label,
    whitelistEnabled,
    mint,
    tokenConfig,
    authorityPda,
    authorityBump,
    extraAccountMetaList,
    adminRolePda,
    minterRolePda,
    burnerRolePda,
    defaultAdminRolePda,
    adminWl: whitelistPda(m, admin.publicKey, programId),
    adminBl: blocklistPda(m, admin.publicKey, programId),
  };
}

async function buildCtx(): Promise<Ctx> {
  // Fund the fee-payer wallet and all test actors.
  const air = async (pk: PublicKey, sol: number) => {
    const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  };
  await air(admin.publicKey, 100);
  for (const u of [alice, bob, carol, delegate, outsider, blocked, mallory]) await air(u.publicKey, 5);

  const on = await setupMode(true, "whitelist-enabled");
  const off = await setupMode(false, "whitelist-disabled");

  // On the whitelist-enabled mint, make the compliant actors whitelisted (incl. admin, the
  // minter/caller). Non-compliant actors (outsider, blocked, mallory) are left off.
  for (const u of [admin, alice, bob, carol, delegate]) await addWhitelist(on, u.publicKey);

  return {
    program, provider, connection, admin, programId,
    on, off, alice, bob, carol, delegate, outsider, blocked, mallory,
  };
}

let readyPromise: Promise<Ctx> | null = null;

/** Lazily builds the shared two-mint context exactly once across all spec files. */
export function getCtx(): Promise<Ctx> {
  if (!readyPromise) readyPromise = buildCtx();
  return readyPromise;
}
