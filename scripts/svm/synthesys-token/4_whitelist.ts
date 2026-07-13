/**
 * Step 4 (synthesys-token): whitelist addresses via add_list_entry(Whitelist, account).
 * Only valid on whitelist-ENABLED mints (rejected with WhitelistNotEnabled otherwise).
 *
 * Whitelists (by default) the CCIP fee-billing signer, the pool signer, and the admin wallet,
 * plus any addresses in WHITELIST_EXTRA (comma-separated base58).
 *
 * Run: SYN_ENV_FILE=.env-synthesys-rwa [WHITELIST_EXTRA=<addr,addr>] \
 *        ts-node scripts/svm/synthesys-token/4_whitelist.ts
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  loadEnv, loadWallet, getProgram, mintPk, whitelistEnabled, pdas,
  feeBillingSigner, poolSigner, TOKEN_2022,
} from "./_lib";

async function main() {
  loadEnv();
  if (!whitelistEnabled()) {
    console.log("Mint is whitelist-DISABLED — nothing to whitelist. Skipping.");
    return;
  }
  const wallet = loadWallet();
  const program = getProgram(wallet);
  const mint = mintPk();

  const targets: { label: string; pk: PublicKey }[] = [
    { label: "admin wallet", pk: wallet.publicKey },
    { label: "CCIP fee-billing signer", pk: feeBillingSigner() },
    { label: "CCIP pool signer", pk: poolSigner(mint) },
  ];
  for (const extra of (process.env.WHITELIST_EXTRA || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    targets.push({ label: "extra", pk: new PublicKey(extra) });
  }

  for (const t of targets) {
    const entry = pdas.whitelist(mint, t.pk);
    try {
      const sig = await (program.methods as any)
        .addWhitelist(t.pk)
        .accounts({
          authority: wallet.publicKey,
          payer: wallet.publicKey,
          roleEntry: pdas.adminRole(mint, wallet.publicKey),
          tokenConfig: pdas.tokenConfig(mint),
          mint,
          whitelistEntry: entry,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc({ commitment: "confirmed", skipPreflight: true });
      console.log(`✅ whitelisted ${t.label} ${t.pk.toBase58()} tx:${sig}`);
    } catch (e: any) {
      const info = await program.provider.connection.getAccountInfo(entry);
      if (info) console.log(`⏭️  ${t.label} already whitelisted`);
      else throw e;
    }
  }
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
