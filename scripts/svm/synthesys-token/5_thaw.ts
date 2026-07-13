/**
 * Step 5 (synthesys-token): thaw a token account (thaw_token_account).
 * New Token-2022 accounts start Frozen (DefaultAccountState=Frozen); they must be thawed
 * before they can hold/move tokens. Requires the owner to be whitelisted (on whitelist-enabled
 * mints) and not blocklisted.
 *
 * Creates the owner's ATA if missing.
 *
 * Env: SYN_ENV_FILE, THAW_OWNER (base58; default = pool signer PDA).
 * Run: SYN_ENV_FILE=.env-synthesys-rwa THAW_OWNER=<owner> ts-node scripts/svm/synthesys-token/5_thaw.ts
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import {
  loadEnv, loadWallet, getProgram, conn, mintPk, whitelistEnabled, pdas, ata, poolSigner, TOKEN_2022,
} from "./_lib";

async function main() {
  loadEnv();
  const wallet = loadWallet();
  const program = getProgram(wallet);
  const connection = conn();
  const mint = mintPk();

  const owner = process.env.THAW_OWNER ? new PublicKey(process.env.THAW_OWNER) : poolSigner(mint);
  const tokenAccount = ata(mint, owner);

  // create ATA if missing
  const info = await connection.getAccountInfo(tokenAccount);
  if (!info) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(wallet.publicKey, tokenAccount, owner, mint, TOKEN_2022)
    );
    const s = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
    console.log("  created ATA", tokenAccount.toBase58(), "tx:", s);
  }

  const sig = await (program.methods as any)
    .thawTokenAccount()
    .accounts({
      signer: wallet.publicKey,
      tokenConfig: pdas.tokenConfig(mint),
      mint,
      tokenAccount,
      ownerWhitelist: whitelistEnabled() ? pdas.whitelist(mint, owner) : null,
      ownerBlocklist: pdas.blocklist(mint, owner),
      authorityPda: pdas.authority(mint),
      tokenProgram: TOKEN_2022,
    })
    .signers([wallet])
    .rpc({ commitment: "confirmed", skipPreflight: true });
  console.log(`✅ thawed ATA of ${owner.toBase58()} (${tokenAccount.toBase58()}) tx:${sig}`);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
