/**
 * Step 6 (synthesys-token): mint tokens to a recipient (program `mint`, MINTER_ROLE).
 * Requires mint authority == authority_pda (i.e. run BEFORE handing authority to the CCIP pool).
 * Recipient must be whitelisted (on whitelist-enabled mints), not blocklisted, and thawed.
 *
 * Env: SYN_ENV_FILE, MINT_RECIPIENT (base58; default = wallet), MINT_AMOUNT (raw base units).
 * Run: SYN_ENV_FILE=.env-synthesys-rwa MINT_RECIPIENT=<addr> MINT_AMOUNT=1000000000000000000 \
 *        ts-node scripts/svm/synthesys-token/6_mint.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  loadEnv, loadWallet, getProgram, mintPk, whitelistEnabled, pdas, ata, TOKEN_2022,
} from "./_lib";

async function main() {
  loadEnv();
  const wallet = loadWallet();
  const program = getProgram(wallet);
  const mint = mintPk();

  const recipient = process.env.MINT_RECIPIENT ? new PublicKey(process.env.MINT_RECIPIENT) : wallet.publicKey;
  const amount = new anchor.BN(process.env.MINT_AMOUNT || "1000000000000000000"); // default 1 token (18 dp)
  const recipientTokenAccount = ata(mint, recipient);

  const sig = await (program.methods as any)
    .mint(amount)
    .accounts({
      signer: wallet.publicKey,
      roleEntry: pdas.minterRole(mint, wallet.publicKey),
      tokenConfig: pdas.tokenConfig(mint),
      mint,
      recipientTokenAccount,
      recipientWhitelist: whitelistEnabled() ? pdas.whitelist(mint, recipient) : null,
      recipientBlocklist: pdas.blocklist(mint, recipient),
      signerWhitelist: whitelistEnabled() ? pdas.whitelist(mint, wallet.publicKey) : null,
      signerBlocklist: pdas.blocklist(mint, wallet.publicKey),
      authorityPda: pdas.authority(mint),
      tokenProgram: TOKEN_2022,
    })
    .signers([wallet])
    .rpc({ commitment: "confirmed", skipPreflight: true });
  console.log(`✅ minted ${amount.toString()} to ${recipient.toBase58()} (${recipientTokenAccount.toBase58()}) tx:${sig}`);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
