/**
 * Toggle a compliant mint's TransferHook extension program id on/off.
 *
 * Why: the deployed CCIP router's onramp does a raw 4-account transfer_checked
 * (chainlink-ccip: ccip-router/src/instructions/v1/pools.rs::transfer_token), so
 * Token-2022 can't resolve the hook's ExtraAccountMetaList and outbound bridge
 * sends fail. Ops flow per Solana→EVM send: off → ccip_send → on.
 * Freeze-state compliance stays enforced throughout; only the hook's
 * pause-on-transfer/delegate checks are suspended while off.
 *
 * Env:
 *   PROGRAM_ID    rwa-token or z-token program id (required)
 *   IDL_PATH      e.g. target/idl/RWAToken.json (required)
 *   MINT_ADDRESS  the Token-2022 mint (required)
 *   ACTION        "off" (unset hook) or "on" (restore hook = PROGRAM_ID) (required)
 *
 * Run:
 *   PROGRAM_ID=... IDL_PATH=... MINT_ADDRESS=... ACTION=off \
 *     ts-node scripts/svm/token/toggle-transfer-hook.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMint, getTransferHook } from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });

const TOKEN_CONFIG_SEED = Buffer.from("token_config");
const ROLE_SEED = Buffer.from("role");
const AUTHORITY_SEED = Buffer.from("authority");
const ADMIN_ROLE = Buffer.from("ADMIN_ROLE");

async function main() {
  const programId = new PublicKey(process.env.PROGRAM_ID!);
  const idlPath = process.env.IDL_PATH!;
  const mint = new PublicKey(process.env.MINT_ADDRESS!);
  const action = (process.env.ACTION || "").toLowerCase();
  if (action !== "on" && action !== "off") throw new Error('Set ACTION to "on" or "off"');

  const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const walletPath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
  const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  anchor.setProvider(provider);
  idl.address = programId.toBase58();
  const program = new anchor.Program(idl as any, provider);

  const [tokenConfig] = PublicKey.findProgramAddressSync([TOKEN_CONFIG_SEED, mint.toBuffer()], programId);
  const [roleEntry] = PublicKey.findProgramAddressSync([ROLE_SEED, mint.toBuffer(), ADMIN_ROLE, wallet.publicKey.toBuffer()], programId);
  const [authorityPda] = PublicKey.findProgramAddressSync([AUTHORITY_SEED, mint.toBuffer()], programId);

  const before = getTransferHook(await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID));
  console.log("Hook before:", before?.programId?.toBase58() ?? "(none)");

  const newHookProgram = action === "on" ? programId : null;
  console.log(`Setting hook -> ${newHookProgram ? newHookProgram.toBase58() : "(none)"}`);

  const sig = await (program.methods as any)
    .updateTransferHookProgram(newHookProgram)
    .accounts({
      signer: wallet.publicKey,
      roleEntry,
      tokenConfig,
      authorityPda,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .signers([wallet])
    .rpc({ commitment: "confirmed", skipPreflight: true });
  console.log("tx:", sig);

  const after = getTransferHook(await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID));
  console.log("Hook after:", after?.programId?.toBase58() ?? "(none)");
  const expected = newHookProgram?.toBase58() ?? PublicKey.default.toBase58();
  const actual = after?.programId?.toBase58() ?? PublicKey.default.toBase58();
  if (actual !== expected && !(expected === PublicKey.default.toBase58() && actual === PublicKey.default.toBase58())) {
    throw new Error(`Hook state mismatch: expected ${expected}, got ${actual}`);
  }
  console.log("✅ Done.");
}

main().catch((e) => {
  console.error("Error:", e.message || e);
  process.exit(1);
});
