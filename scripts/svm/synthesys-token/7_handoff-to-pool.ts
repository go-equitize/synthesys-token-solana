/**
 * Step 7 (synthesys-token): hand mint authority from authority_pda to the CCIP pool signer PDA.
 * After this the program can no longer mint locally — new supply on Solana appears only by
 * bridging in from EVM (the pool mints on delivery). Burns (outbound) still work via the
 * permanent delegate. This is the final CCIP wiring step; run it AFTER local test-minting.
 *
 * transfer_mint_authority requires the CURRENT mint authority to be authority_pda; the program
 * signs the SetAuthority CPI as the PDA. So the wallet must first hand authority back to
 * authority_pda (spl-token authorize) — done by this script when NEEDED via --no auto handled
 * externally. Here we simply call transfer_mint_authority(newAuthority=poolSigner).
 *
 * Env: SYN_ENV_FILE. Run AFTER: spl-token authorize <mint> mint <authority_pda> (wallet signs).
 */
import { loadEnv, loadWallet, getProgram, mintPk, pdas, poolSigner, TOKEN_2022 } from "./_lib";

async function main() {
  loadEnv();
  const wallet = loadWallet();
  const program = getProgram(wallet);
  const mint = mintPk();
  const newAuthority = poolSigner(mint);

  const sig = await (program.methods as any)
    .transferMintAuthority(newAuthority)
    .accounts({
      signer: wallet.publicKey,
      roleEntry: pdas.adminRole(mint, wallet.publicKey),
      tokenConfig: pdas.tokenConfig(mint),
      authorityPda: pdas.authority(mint),
      mint,
      tokenProgram: TOKEN_2022,
    })
    .signers([wallet])
    .rpc({ commitment: "confirmed", skipPreflight: true });
  console.log(`✅ mint authority -> pool signer ${newAuthority.toBase58()} tx:${sig}`);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
