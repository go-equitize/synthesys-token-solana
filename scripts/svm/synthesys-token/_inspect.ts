/** Preflight: inspect admin roles / whitelist / config for both mints. */
import { PublicKey } from "@solana/web3.js";
import {
  loadEnv, loadWallet, conn, mintPk, pdas, ata, TOKEN_2022,
} from "./_lib";
import { getAccount, getMint } from "@solana/spl-token";

async function inspectMint(label: string) {
  const wallet = loadWallet();
  const c = conn();
  const mint = mintPk();
  const has = async (pk: PublicKey) => !!(await c.getAccountInfo(pk));

  console.log(`\n===== ${label} — mint ${mint.toBase58()} =====`);
  const cfg = pdas.tokenConfig(mint);
  console.log("token_config:", cfg.toBase58(), "exists:", await has(cfg));
  console.log("authority_pda:", pdas.authority(mint).toBase58(), "exists:", await has(pdas.authority(mint)));
  console.log("admin ADMIN_ROLE:", await has(pdas.adminRole(mint, wallet.publicKey)));
  console.log("admin MINTER_ROLE:", await has(pdas.minterRole(mint, wallet.publicKey)));
  console.log("admin BURNER_ROLE:", await has(pdas.burnerRole(mint, wallet.publicKey)));
  console.log("admin whitelisted:", await has(pdas.whitelist(mint, wallet.publicKey)));
  console.log("admin blocklisted:", await has(pdas.blocklist(mint, wallet.publicKey)));
  const m = await getMint(c, mint, "confirmed", TOKEN_2022);
  console.log("decimals:", m.decimals, "supply:", m.supply.toString(), "mintAuthority:", m.mintAuthority?.toBase58());
  const adminAta = ata(mint, wallet.publicKey);
  try {
    const acc = await getAccount(c, adminAta, "confirmed", TOKEN_2022);
    console.log("admin ATA:", adminAta.toBase58(), "amount:", acc.amount.toString(), "frozen:", acc.isFrozen);
  } catch { console.log("admin ATA:", adminAta.toBase58(), "does not exist"); }
}

async function main() {
  loadEnv();
  console.log("wallet:", loadWallet().publicKey.toBase58());
  console.log("RPC:", conn().rpcEndpoint);
  await inspectMint(process.env.SYN_WHITELIST_ENABLED === "true" ? "WHITELIST-ENABLED" : "WHITELIST-DISABLED");
}
main().catch((e) => { console.error(e); process.exit(1); });
