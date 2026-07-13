/**
 * Shared helpers for synthesys-token operational scripts.
 * PDA derivation mirrors programs/synthesys-token/src/constants.rs.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";

export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID;
export const CCIP_ROUTER = new PublicKey("Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C");
export const BURN_MINT_POOL_PROGRAM = new PublicKey("41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB");

const S = {
  tokenConfig: Buffer.from("token_config"),
  whitelist: Buffer.from("whitelist"),
  blocklist: Buffer.from("blocklist"),
  role: Buffer.from("role"),
  authority: Buffer.from("authority"),
  ADMIN: Buffer.from("ADMIN_ROLE"),
  MINTER: Buffer.from("MINTER_ROLE"),
  BURNER: Buffer.from("BURNER_ROLE"),
};

export function loadEnv() {
  dotenv.config({ path: ".env" });
  const envFile = process.env.SYN_ENV_FILE || ".env-synthesys";
  dotenv.config({ path: envFile, override: false });
}

export function loadWallet(): Keypair {
  const p = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

export function conn(): Connection {
  return new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
}

export function programId(): PublicKey {
  return new PublicKey(
    process.env.SYN_TOKEN_PROGRAM_ID || "7rCrfZnJakWfGfUmHovVGWFvwxnELfxnXzebmatjXeHp"
  );
}

export function mintPk(): PublicKey {
  const m = process.env.MINT_ADDRESS || process.env.SYN_MINT_ADDRESS;
  if (!m) throw new Error("Set SYN_MINT_ADDRESS (via SYN_ENV_FILE)");
  return new PublicKey(m);
}

export function whitelistEnabled(): boolean {
  return process.env.SYN_WHITELIST_ENABLED === "true";
}

export function getProgram(wallet: Keypair): anchor.Program {
  const idl: anchor.Idl = JSON.parse(fs.readFileSync("./target/idl/SynthesysToken.json", "utf-8"));
  const provider = new anchor.AnchorProvider(conn(), new anchor.Wallet(wallet), {
    commitment: "confirmed",
    skipPreflight: true,
    preflightCommitment: "processed",
  });
  anchor.setProvider(provider);
  idl.address = programId().toBase58();
  return new anchor.Program(idl as any, provider);
}

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId())[0];

export const pdas = {
  tokenConfig: (mint: PublicKey) => pda([S.tokenConfig, mint.toBuffer()]),
  authority: (mint: PublicKey) => pda([S.authority, mint.toBuffer()]),
  whitelist: (mint: PublicKey, owner: PublicKey) => pda([S.whitelist, mint.toBuffer(), owner.toBuffer()]),
  blocklist: (mint: PublicKey, owner: PublicKey) => pda([S.blocklist, mint.toBuffer(), owner.toBuffer()]),
  adminRole: (mint: PublicKey, who: PublicKey) => pda([S.role, mint.toBuffer(), S.ADMIN, who.toBuffer()]),
  minterRole: (mint: PublicKey, who: PublicKey) => pda([S.role, mint.toBuffer(), S.MINTER, who.toBuffer()]),
  burnerRole: (mint: PublicKey, who: PublicKey) => pda([S.role, mint.toBuffer(), S.BURNER, who.toBuffer()]),
};

export function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022);
}

export function feeBillingSigner(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("fee_billing_signer")], CCIP_ROUTER)[0];
}

export function poolSigner(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ccip_tokenpool_signer"), mint.toBuffer()],
    BURN_MINT_POOL_PROGRAM
  )[0];
}
