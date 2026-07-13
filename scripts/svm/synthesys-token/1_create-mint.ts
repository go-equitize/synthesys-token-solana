/**
 * Step 1 (synthesys-token): Create a Token-2022 mint with all compliance extensions.
 *
 * Parameterized clone of scripts/svm/rwa-token/1_create-rwa-token-mint.ts, targeting the
 * synthesys-token program. The synthesys program serves BOTH whitelist-enabled and
 * whitelist-disabled mints from one binary; the whitelist mode is chosen later at
 * initialize() time (2_initialize.ts), NOT here — the mint itself is identical in both modes.
 *
 * Extension order (order matters for Token-2022):
 *   MintCloseAuthority -> PermanentDelegate -> DefaultAccountState(Frozen)
 *   -> TransferHook(synthesys program) -> MetadataPointer -> InitializeMint
 *
 * Env:
 *   SYN_TOKEN_PROGRAM_ID   synthesys program id (default: declared id)
 *   SYN_TOKEN_NAME         metadata name   (e.g. "RWAToken")
 *   SYN_TOKEN_SYMBOL       metadata symbol (e.g. "RWA")
 *   SYN_TOKEN_URI          metadata uri    (optional)
 *   SYN_TOKEN_DECIMALS     decimals (default 18, to match the EVM twin)
 *   SYN_ENV_FILE           path to write the resulting addresses (e.g. .env-synthesys-rwa)
 *
 * Run:
 *   SYN_TOKEN_NAME=RWAToken SYN_TOKEN_SYMBOL=RWA SYN_ENV_FILE=.env-synthesys-rwa \
 *     ts-node scripts/svm/synthesys-token/1_create-mint.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeTransferHookInstruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializeMetadataPointerInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  tokenMetadataInitializeWithRentTransfer,
  ExtensionType,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
  AccountState,
} from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const SYN_TOKEN_PROGRAM_ID = new PublicKey(
  process.env.SYN_TOKEN_PROGRAM_ID || "7rCrfZnJakWfGfUmHovVGWFvwxnELfxnXzebmatjXeHp"
);

const TOKEN_DECIMALS = parseInt(process.env.SYN_TOKEN_DECIMALS || "18", 10);
const TOKEN_NAME = process.env.SYN_TOKEN_NAME || "Synthesys Token";
const TOKEN_SYMBOL = process.env.SYN_TOKEN_SYMBOL || "SYN";
const TOKEN_URI = process.env.SYN_TOKEN_URI || "";
const ENV_FILE = process.env.SYN_ENV_FILE || ".env-synthesys";

function findAuthorityPDA(mint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("authority"), mint.toBuffer()],
    programId
  );
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
  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("Program:", SYN_TOKEN_PROGRAM_ID.toBase58());
  console.log("Token:  ", TOKEN_NAME, `(${TOKEN_SYMBOL})`, "decimals", TOKEN_DECIMALS);

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const [authorityPda, authorityBump] = findAuthorityPDA(mint, SYN_TOKEN_PROGRAM_ID);
  console.log("Mint address: ", mint.toBase58());
  console.log("Authority PDA:", authorityPda.toBase58(), "(bump:", authorityBump, ")");

  const extensions = [
    ExtensionType.PermanentDelegate,
    ExtensionType.DefaultAccountState,
    ExtensionType.TransferHook,
    ExtensionType.MintCloseAuthority,
    ExtensionType.MetadataPointer,
  ];
  const mintLen = getMintLen(extensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    })
  );
  tx.add(
    createInitializeMintCloseAuthorityInstruction(mint, authorityPda, TOKEN_2022_PROGRAM_ID)
  );
  tx.add(
    createInitializePermanentDelegateInstruction(mint, authorityPda, TOKEN_2022_PROGRAM_ID)
  );
  tx.add(
    createInitializeDefaultAccountStateInstruction(mint, AccountState.Frozen, TOKEN_2022_PROGRAM_ID)
  );
  tx.add(
    createInitializeTransferHookInstruction(
      mint,
      authorityPda,
      SYN_TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID
    )
  );
  tx.add(
    createInitializeMetadataPointerInstruction(mint, wallet.publicKey, mint, TOKEN_2022_PROGRAM_ID)
  );
  tx.add(
    createInitializeMintInstruction(
      mint,
      TOKEN_DECIMALS,
      wallet.publicKey, // temporary mint authority (for metadata init)
      authorityPda, // freeze authority
      TOKEN_2022_PROGRAM_ID
    )
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [wallet, mintKeypair], {
    commitment: "finalized",
  });
  console.log("\n✅ Mint created. sig:", sig);

  const metadataSig = await tokenMetadataInitializeWithRentTransfer(
    connection,
    wallet,
    mint,
    authorityPda,
    wallet,
    TOKEN_NAME,
    TOKEN_SYMBOL,
    TOKEN_URI,
    [],
    { commitment: "finalized" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log("✅ Metadata set. sig:", metadataSig);

  // Hand mint authority + metadata pointer authority to authority_pda (required by initialize()).
  const handoffTx = new Transaction();
  handoffTx.add(
    createSetAuthorityInstruction(
      mint,
      wallet.publicKey,
      AuthorityType.MintTokens,
      authorityPda,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );
  handoffTx.add(
    createSetAuthorityInstruction(
      mint,
      wallet.publicKey,
      AuthorityType.MetadataPointer,
      authorityPda,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );
  const handoffSig = await sendAndConfirmTransaction(connection, handoffTx, [wallet], {
    commitment: "finalized",
  });
  console.log("✅ Authority handed to authority_pda. sig:", handoffSig);

  const envContent =
    `SYN_MINT_ADDRESS=${mint.toBase58()}\n` +
    `SYN_TOKEN_PROGRAM_ID=${SYN_TOKEN_PROGRAM_ID.toBase58()}\n` +
    `SYN_AUTHORITY_PDA=${authorityPda.toBase58()}\n` +
    `SYN_TOKEN_NAME=${TOKEN_NAME}\n` +
    `SYN_TOKEN_SYMBOL=${TOKEN_SYMBOL}\n` +
    `SYN_TOKEN_DECIMALS=${TOKEN_DECIMALS}\n`;
  fs.writeFileSync(ENV_FILE, envContent);
  console.log(`\n📋 Mint: ${mint.toBase58()}`);
  console.log(`Saved to ${ENV_FILE}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
