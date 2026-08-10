/**
 * Step 2 (synthesys-token): Initialize program governance for a mint.
 *
 * Adapted from scripts/svm/rwa-token/2_initialize-program.ts. The ONLY functional
 * difference vs rwa-token is that synthesys `initialize` takes a third arg,
 * `whitelist_enabled: bool`, recorded immutably in TokenConfig (there is no setter).
 *
 * Creates: TokenConfig PDA, 4 RoleEntry PDAs (ADMIN/MINTER/BURNER/DEFAULT_ADMIN for admin),
 * ExtraAccountMetaList PDA (transfer-hook). Then hands mint authority back to the wallet
 * so CCIP pool init / propose-administrator can run.
 *
 * Env:
 *   SYN_TOKEN_PROGRAM_ID, SYN_MINT_ADDRESS (or MINT_ADDRESS), SYN_ENV_FILE
 *   SYN_WHITELIST_ENABLED  "true"|"false"  (REQUIRED — the immutable per-mint mode)
 *   CCIP_ADMIN             optional (default = wallet)
 *
 * Run:
 *   SYN_ENV_FILE=.env-synthesys-rwa SYN_WHITELIST_ENABLED=true \
 *     ts-node scripts/svm/synthesys-token/2_initialize.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });
const ENV_FILE = process.env.SYN_ENV_FILE || ".env-synthesys";
dotenv.config({ path: ENV_FILE, override: false });

const SYN_TOKEN_PROGRAM_ID = new PublicKey(
  process.env.SYN_TOKEN_PROGRAM_ID || "7rCrfZnJakWfGfUmHovVGWFvwxnELfxnXzebmatjXeHp"
);

const TOKEN_CONFIG_SEED = Buffer.from("token_config");
const ROLE_SEED = Buffer.from("role");
const EXTRA_ACCOUNT_METAS_SEED = Buffer.from("extra-account-metas");
const AUTHORITY_SEED = Buffer.from("authority");
const ADMIN_ROLE = Buffer.from("ADMIN_ROLE");
const MINTER_ROLE = Buffer.from("MINTER_ROLE");
const BURNER_ROLE = Buffer.from("BURNER_ROLE");
const DEFAULT_ADMIN_ROLE = Buffer.from("DEFAULT_ADMIN_ROLE");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function pda(seeds: Buffer[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, SYN_TOKEN_PROGRAM_ID);
}

async function main() {
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const walletPath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
  const wallet = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );

  const mintAddress = process.env.MINT_ADDRESS || process.env.SYN_MINT_ADDRESS;
  if (!mintAddress) throw new Error("Set SYN_MINT_ADDRESS (or MINT_ADDRESS)");
  const mint = new PublicKey(mintAddress);

  if (process.env.SYN_WHITELIST_ENABLED === undefined) {
    throw new Error("Set SYN_WHITELIST_ENABLED=true|false (immutable per-mint mode)");
  }
  const whitelistEnabled = process.env.SYN_WHITELIST_ENABLED === "true";

  const admin = wallet.publicKey;
  const ccipAdmin = process.env.CCIP_ADMIN ? new PublicKey(process.env.CCIP_ADMIN) : wallet.publicKey;

  console.log("Initialize synthesys-token");
  console.log("  Mint:            ", mint.toBase58());
  console.log("  Admin:           ", admin.toBase58());
  console.log("  whitelistEnabled:", whitelistEnabled);

  const idl: anchor.Idl = JSON.parse(fs.readFileSync("./target/idl/SynthesysToken.json", "utf-8"));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
    skipPreflight: true,
    preflightCommitment: "processed",
  });
  anchor.setProvider(provider);
  idl.address = SYN_TOKEN_PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as any, provider);

  const [tokenConfig] = pda([TOKEN_CONFIG_SEED, mint.toBuffer()]);
  const [authorityPda] = pda([AUTHORITY_SEED, mint.toBuffer()]);
  const [adminRole] = pda([ROLE_SEED, mint.toBuffer(), ADMIN_ROLE, admin.toBuffer()]);
  const [minterRole] = pda([ROLE_SEED, mint.toBuffer(), MINTER_ROLE, admin.toBuffer()]);
  const [burnerRole] = pda([ROLE_SEED, mint.toBuffer(), BURNER_ROLE, admin.toBuffer()]);
  const [defaultAdminRole] = pda([ROLE_SEED, mint.toBuffer(), DEFAULT_ADMIN_ROLE, admin.toBuffer()]);
  const [extraAccountMetaList] = pda([EXTRA_ACCOUNT_METAS_SEED, mint.toBuffer()]);
  const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync(
    [SYN_TOKEN_PROGRAM_ID.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID
  );

  console.log("\nStep A: initialize()...");
  const initSig = await (program.methods as any)
    .initialize(admin, ccipAdmin, whitelistEnabled)
    .accounts({
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      mint,
      tokenConfig,
      adminRoleEntry: adminRole,
      minterRoleEntry: minterRole,
      burnerRoleEntry: burnerRole,
      defaultAdminRoleEntry: defaultAdminRole,
      authorityPda,
      programData,
      programConfig: null,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([wallet])
    .rpc({ commitment: "confirmed", skipPreflight: true });
  console.log("  ✅ initialize tx:", initSig);

  console.log("\nStep B: initialize_extra_account_meta_list()...");
  const hookSig = await (program.methods as any)
    .initializeExtraAccountMetaList()
    .accounts({
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      roleEntry: adminRole,
      tokenConfig,
      mint,
      extraAccountMetaList,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([wallet])
    .rpc({ commitment: "confirmed", skipPreflight: true });
  console.log("  ✅ initializeExtraAccountMetaList tx:", hookSig);

  console.log("\nStep C: transfer_mint_authority(wallet) — enables CCIP setup...");
  const transferSig = await (program.methods as any)
    .transferMintAuthority(wallet.publicKey)
    .accounts({
      signer: wallet.publicKey,
      roleEntry: adminRole,
      tokenConfig,
      authorityPda,
      mint,
      tokenProgram: TOKEN_2022,
    })
    .signers([wallet])
    .rpc({ commitment: "confirmed", skipPreflight: true });
  console.log("  ✅ transferMintAuthority tx:", transferSig);

  const envAppend =
    `SYN_TOKEN_CONFIG=${tokenConfig.toBase58()}\n` +
    `SYN_EXTRA_ACCOUNT_META_LIST=${extraAccountMetaList.toBase58()}\n` +
    `SYN_WHITELIST_ENABLED=${whitelistEnabled}\n`;
  fs.appendFileSync(ENV_FILE, envAppend);
  console.log(`\n🎉 Initialized. Appended config to ${ENV_FILE}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
