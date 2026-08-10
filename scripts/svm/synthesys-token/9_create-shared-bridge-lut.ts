/**
 * Step 9 (synthesys-token): ONE-TIME admin setup — create a SHARED compression
 * Address Lookup Table (LUT) for the SVM -> EVM bridge send.
 *
 * Why: the deployed CCIP router's ccip_send for this Token-2022 + transfer-hook
 * token must be wrapped as [pre_bridge_send, computeBudget, ccipSend,
 * post_bridge_restore] in a single versioned tx, which does NOT fit in the
 * 1232-byte limit without compressing account keys into a LUT. 8_bridge-send.ts
 * creates a throwaway compression LUT every run (3-4 signatures). For the bridge
 * UI we instead create this LUT ONCE, store its address in the bridge config,
 * and every user's browser send just references it — so end users never sign a
 * LUT create/extend, only the delegate-approve + the bridge tx.
 *
 * The LUT holds the STATIC keys of the wrapped tx (program ids, router/feeQuoter/
 * RMN config PDAs, dest-chain state, mint-scoped hook PDAs, fee accounts). A few
 * per-user keys (the caller's token account / nonce PDA) are NOT in it and stay
 * inline in each user's tx — that's fine, the bulk is compressed either way.
 *
 * This mirrors the [3]+[5b] blocks of 8_bridge-send.ts exactly (same derive loop,
 * same "keys not already in the pool ALT" set), then stops after creating the LUT.
 *
 * Env: SYN_ENV_FILE (mint/program), ANCHOR_WALLET (admin keypair)
 * Run: SYN_ENV_FILE=.env-synthesys-rwa \
 *        ts-node scripts/svm/synthesys-token/9_create-shared-bridge-lut.ts
 */
import * as anchor from "@coral-xyz/anchor";
import {
  AccountMeta, Connection, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction, sendAndConfirmTransaction, AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import {
  findConfigPDA, findDestChainStatePDA, findNoncePDA, findFeeBillingSignerPDA, findFqConfigPDA,
  findFqDestChainPDA, findFqBillingTokenConfigPDA, findRMNRemoteCursesPDA, findRMNRemoteConfigPDA,
} from "../../../ccip-lib/svm/utils/pdas";
import { ChainId, getCCIPSVMConfig, CHAIN_SELECTORS } from "../../config";
import { loadEnv, loadWallet, programId, mintPk, whitelistEnabled, pdas } from "./_lib";

async function main() {
  loadEnv();
  const decimals = Number(process.env.SYN_TOKEN_DECIMALS || "9");
  const SYN = programId();
  const mint = mintPk();
  const config = getCCIPSVMConfig(ChainId.SOLANA_DEVNET);
  const connection: Connection = config.connection;
  const wallet = loadWallet();
  console.log("Admin wallet:", wallet.publicKey.toBase58(), "Mint:", mint.toBase58());

  // Representative message — the DERIVED accounts depend on (destChainSelector,
  // mint, caller), not on the receiver value or amount, so a dummy 0x0 receiver
  // and amount=1 base unit enumerate the same account set every user will use.
  const amount = new anchor.BN(1);
  const receiverBytes = Buffer.alloc(32); // 0x00..00 EVM receiver placeholder
  const destChainSelector = new anchor.BN(CHAIN_SELECTORS[ChainId.ETHEREUM_SEPOLIA].toString());
  const extraArgs = Buffer.alloc(0);
  const message = { receiver: receiverBytes, data: Buffer.from([]), tokenAmounts: [{ token: mint, amount }], feeToken: PublicKey.default, extraArgs };

  const [feeBillingSigner] = findFeeBillingSignerPDA(config.routerProgramId);
  const userTokenAccount = await getAssociatedTokenAddress(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);

  console.log("\n[1] Deriving ccipSend accounts (hook-aware)...");
  const routerIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../ccip-lib/svm/idl/ccip_router.json"), "utf-8"));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const routerProgram = new anchor.Program(routerIdl as any, provider);
  const [configPda] = findConfigPDA(config.routerProgramId);

  const deriveParams = { destChainSelector, ccipSendCaller: wallet.publicKey, message };
  let stage = "Start";
  let remainingAccounts: AccountMeta[] = [];
  const accountsToSave: AccountMeta[] = [];
  const lookupTableAddresses: PublicKey[] = [];
  const tokenIndexes: number[] = [];
  let safety = 0;
  while (safety++ < 20) {
    const result: any = await routerProgram.methods.deriveAccountsCcipSend(deriveParams, stage)
      .accounts({ config: configPda }).remainingAccounts(remainingAccounts).view();
    console.log(`  stage="${result.currentStage}" +${result.accountsToSave.length} next="${result.nextStage}"`);
    if (typeof result.currentStage === "string" && /^TokenTransferStaticAccounts\/\d+\/0$/.test(result.currentStage))
      tokenIndexes.push(accountsToSave.length);
    for (const a of result.accountsToSave) accountsToSave.push({ pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable });
    for (const lut of result.lookUpTablesToSave) lookupTableAddresses.push(lut);
    if (!result.nextStage) break;
    stage = result.nextStage;
    remainingAccounts = result.askAgainWith.map((a: any) => ({ pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable }));
  }
  console.log(`  ${accountsToSave.length} remaining accts, ${lookupTableAddresses.length} pool LUT(s)`);

  console.log("\n[2] Building ccipSend + pre/post ixs (for key enumeration)...");
  const sel = BigInt(destChainSelector.toString());
  const feeTokenMint = NATIVE_MINT;
  const [destChainState] = findDestChainStatePDA(sel, config.routerProgramId);
  const [nonce] = findNoncePDA(sel, wallet.publicKey, config.routerProgramId);
  const [feeQuoterConfig] = findFqConfigPDA(config.feeQuoterProgramId);
  const [fqDestChain] = findFqDestChainPDA(sel, config.feeQuoterProgramId);
  const [fqBillingTokenConfig] = findFqBillingTokenConfigPDA(feeTokenMint, config.feeQuoterProgramId);
  const [fqLinkBillingTokenConfig] = findFqBillingTokenConfigPDA(config.linkTokenMint, config.feeQuoterProgramId);
  const [rmnRemoteCurses] = findRMNRemoteCursesPDA(config.rmnRemoteProgramId);
  const [rmnRemoteConfig] = findRMNRemoteConfigPDA(config.rmnRemoteProgramId);
  const feeBillingSignerFeeTokenAccount = await getAssociatedTokenAddress(feeTokenMint, feeBillingSigner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const sendIx = await routerProgram.methods.ccipSend(destChainSelector, message, Buffer.from(tokenIndexes))
    .accounts({
      authority: wallet.publicKey, config: configPda, destChainState, nonce,
      systemProgram: anchor.web3.SystemProgram.programId, feeTokenProgram: TOKEN_PROGRAM_ID, feeTokenMint,
      feeTokenUserAssociatedAccount: PublicKey.default, feeTokenReceiver: feeBillingSignerFeeTokenAccount,
      feeBillingSigner, feeQuoter: config.feeQuoterProgramId, feeQuoterConfig, feeQuoterDestChain: fqDestChain,
      feeQuoterBillingTokenConfig: fqBillingTokenConfig, feeQuoterLinkTokenConfig: fqLinkBillingTokenConfig,
      rmnRemote: config.rmnRemoteProgramId, rmnRemoteCurses, rmnRemoteConfig,
    } as any)
    .remainingAccounts(accountsToSave).instruction();

  const synIdl = JSON.parse(fs.readFileSync("./target/idl/SynthesysToken.json", "utf-8"));
  synIdl.address = SYN.toBase58();
  const synProgram = new anchor.Program(synIdl as any, provider);
  const preIx = await (synProgram.methods as any).preBridgeSend().accounts({
    signer: wallet.publicKey, tokenConfig: pdas.tokenConfig(mint), mint,
    signerWhitelist: whitelistEnabled() ? pdas.whitelist(mint, wallet.publicKey) : null,
    signerBlocklist: pdas.blocklist(mint, wallet.publicKey), authorityPda: pdas.authority(mint),
    sourceTokenAccount: userTokenAccount, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  }).instruction();
  const postIx = await (synProgram.methods as any).postBridgeRestore().accounts({
    mint, tokenConfig: pdas.tokenConfig(mint), authorityPda: pdas.authority(mint), tokenProgram: TOKEN_2022_PROGRAM_ID,
  }).instruction();

  console.log("\n[3] Collecting static keys (those NOT already in the pool ALT)...");
  const poolAlt = (await Promise.all(lookupTableAddresses.map((a) => connection.getAddressLookupTable(a))))
    .map((r) => r.value).filter(Boolean).flatMap((v) => v!.state.addresses.map((a) => a.toBase58()));
  const poolSet = new Set(poolAlt);
  const keys = new Map<string, PublicKey>();
  for (const ix of [preIx, sendIx, postIx]) {
    for (const k of ix.keys) if (!poolSet.has(k.pubkey.toBase58())) keys.set(k.pubkey.toBase58(), k.pubkey);
    keys.set(ix.programId.toBase58(), ix.programId);
  }
  const uniq = [...keys.values()];
  console.log(`  ${uniq.length} unique static keys to store in the shared LUT`);

  console.log("\n[4] Creating shared compression LUT...");
  const slot = await connection.getSlot("finalized");
  const [createIx, lutAddr] = AddressLookupTableProgram.createLookupTable({ authority: wallet.publicKey, payer: wallet.publicKey, recentSlot: slot });
  await sendAndConfirmTransaction(connection, new Transaction().add(createIx), [wallet], { commitment: "confirmed" });
  for (let i = 0; i < uniq.length; i += 20) {
    const ext = AddressLookupTableProgram.extendLookupTable({ payer: wallet.publicKey, authority: wallet.publicKey, lookupTable: lutAddr, addresses: uniq.slice(i, i + 20) });
    await sendAndConfirmTransaction(connection, new Transaction().add(ext), [wallet], { commitment: "confirmed" });
  }
  console.log(`  extended with ${uniq.length} addresses; warming up (must be 1 slot old before use)...`);
  const created = await connection.getSlot("confirmed");
  while ((await connection.getSlot("confirmed")) <= created + 1) await new Promise((r) => setTimeout(r, 400));

  console.log("\n========================================");
  console.log("✅ SHARED BRIDGE COMPRESSION LUT CREATED");
  console.log("LUT address:", lutAddr.toBase58());
  console.log("Mint:", mint.toBase58());
  console.log("\nStore this in the bridge config (Firebase /settings/bridge/config):");
  console.log(`  solanaBridge.compressionLut = "${lutAddr.toBase58()}"`);
  console.log("========================================");
}

main().catch((e) => { console.error("Error:", e.stack || e.message || e); process.exit(1); });
