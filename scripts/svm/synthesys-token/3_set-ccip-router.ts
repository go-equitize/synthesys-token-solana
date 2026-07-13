/**
 * Step 3 (synthesys-token): record the CCIP router program id in TokenConfig.
 * Required by pre_bridge_send — the bridge guard verifies the ccip_send is on this router.
 *
 * Run: SYN_ENV_FILE=.env-synthesys-rwa ts-node scripts/svm/synthesys-token/3_set-ccip-router.ts
 */
import { loadEnv, loadWallet, getProgram, mintPk, pdas, CCIP_ROUTER } from "./_lib";

async function main() {
  loadEnv();
  const wallet = loadWallet();
  const program = getProgram(wallet);
  const mint = mintPk();

  const sig = await (program.methods as any)
    .setCcipRouter(CCIP_ROUTER)
    .accounts({
      signer: wallet.publicKey,
      roleEntry: pdas.adminRole(mint, wallet.publicKey),
      tokenConfig: pdas.tokenConfig(mint),
      mint,
    })
    .signers([wallet])
    .rpc({ commitment: "confirmed", skipPreflight: true });
  console.log("✅ set_ccip_router:", CCIP_ROUTER.toBase58(), "tx:", sig);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
