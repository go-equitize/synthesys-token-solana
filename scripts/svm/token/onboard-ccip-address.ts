/**
 * Onboard an address (admin wallet, CCIP fee-billing signer PDA, or CCIP pool signer PDA)
 * against a compliant Token-2022 mint (rwa-token or z-token): create its ATA if missing,
 * whitelist it if the program requires a whitelist, then thaw the ATA.
 *
 * Generalizes scripts/svm/rwa-token/{3_whitelist-setup,5_user-onboard}.ts to also cover
 * z-token (no whitelist) and PDA owners whose ATA already exists but was never thawed
 * (e.g. a CCIP pool's own token account, created by create-pool-token-account.ts, which
 * is frozen at creation just like any other account under DefaultAccountState=Frozen).
 *
 * Env:
 *   PROGRAM_ID       rwa-token or z-token program ID (required)
 *   IDL_PATH         path to built IDL, e.g. target/idl/ZToken.json (required)
 *   HAS_WHITELIST    "true" (rwa-token) or "false" (z-token), default "false"
 *   MINT_ADDRESS     Token-2022 mint (required)
 *   ADDRESS          the address to onboard (wallet or PDA) (required)
 *
 * Run:
 *   PROGRAM_ID=... IDL_PATH=... HAS_WHITELIST=true MINT_ADDRESS=... ADDRESS=... \
 *     ts-node scripts/svm/token/onboard-ccip-address.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });

const TOKEN_CONFIG_SEED = Buffer.from("token_config");
const WHITELIST_SEED = Buffer.from("whitelist");
const BLOCKLIST_SEED = Buffer.from("blocklist");
const ROLE_SEED = Buffer.from("role");
const AUTHORITY_SEED = Buffer.from("authority");
const ADMIN_ROLE = Buffer.from("ADMIN_ROLE");

async function main() {
  const programId = new PublicKey(process.env.PROGRAM_ID!);
  const idlPath = process.env.IDL_PATH!;
  const hasWhitelist = (process.env.HAS_WHITELIST || "false").toLowerCase() === "true";
  const mint = new PublicKey(process.env.MINT_ADDRESS!);
  const address = new PublicKey(process.env.ADDRESS!);

  const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const walletPath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
  const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

  console.log("Program:", programId.toBase58(), hasWhitelist ? "(whitelist+blocklist)" : "(blocklist only)");
  console.log("Mint:   ", mint.toBase58());
  console.log("Address:", address.toBase58());

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  anchor.setProvider(provider);
  idl.address = programId.toBase58();
  const program = new anchor.Program(idl as any, provider);

  const [tokenConfig] = PublicKey.findProgramAddressSync([TOKEN_CONFIG_SEED, mint.toBuffer()], programId);
  const [authorityPda] = PublicKey.findProgramAddressSync([AUTHORITY_SEED, mint.toBuffer()], programId);
  const [adminRoleEntry] = PublicKey.findProgramAddressSync([ROLE_SEED, mint.toBuffer(), ADMIN_ROLE, wallet.publicKey.toBuffer()], programId);
  const [whitelistEntry] = PublicKey.findProgramAddressSync([WHITELIST_SEED, mint.toBuffer(), address.toBuffer()], programId);
  const [blocklistEntry] = PublicKey.findProgramAddressSync([BLOCKLIST_SEED, mint.toBuffer(), address.toBuffer()], programId);
  const ata = getAssociatedTokenAddressSync(mint, address, true, TOKEN_2022_PROGRAM_ID);

  console.log("ATA:    ", ata.toBase58());

  if (hasWhitelist) {
    console.log("\n[A] Whitelisting address...");
    if (await connection.getAccountInfo(whitelistEntry)) {
      console.log("  ⏭️  Already whitelisted.");
    } else {
      const sig = await (program.methods as any)
        .addWhitelist(address)
        .accounts({
          authority: wallet.publicKey,
          payer: wallet.publicKey,
          roleEntry: adminRoleEntry,
          tokenConfig,
          mint,
          whitelistEntry,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([wallet])
        .rpc({ commitment: "confirmed", skipPreflight: true });
      console.log("  ✅ Whitelisted. tx:", sig);
    }
  } else {
    console.log("\n[A] Skipping whitelist (program has none — denylist-only).");
  }

  console.log("\n[B] Ensuring ATA exists...");
  if (await connection.getAccountInfo(ata)) {
    console.log("  ⏭️  ATA already exists.");
  } else {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(wallet.publicKey, ata, address, mint, TOKEN_2022_PROGRAM_ID)
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log("  ✅ ATA created. tx:", sig);
  }

  console.log("\n[C] Thawing ATA...");
  const thawAccounts: Record<string, PublicKey> = {
    signer: wallet.publicKey,
    tokenConfig,
    mint,
    tokenAccount: ata,
    ownerBlocklist: blocklistEntry,
    authorityPda,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  };
  if (hasWhitelist) thawAccounts.ownerWhitelist = whitelistEntry;

  const sig = await (program.methods as any)
    .thawTokenAccount()
    .accounts(thawAccounts)
    .signers([wallet])
    .rpc({ commitment: "confirmed", skipPreflight: true });
  console.log("  ✅ Thawed. tx:", sig);

  console.log("\n🎉 Onboarded:", address.toBase58(), "ATA:", ata.toBase58());
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
