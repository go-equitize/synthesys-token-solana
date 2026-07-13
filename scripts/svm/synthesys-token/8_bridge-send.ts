/**
 * Step 8 (synthesys-token): live SVM -> EVM CCIP send, wrapped atomically in
 * pre_bridge_send / post_bridge_restore (the deployed router's ccip_send can't forward
 * Token-2022 transfer-hook extra accounts, so the hook is toggled off only for the burn,
 * inside a single tx, and restored in the same tx).
 *
 * Builds one versioned tx: [pre_bridge_send, computeBudget, router.ccipSend, post_bridge_restore]
 *
 * Adapted from scripts/svm/rwa-token/13_bridge-send-to-evm.ts. Differences:
 *  - synthesys program id + IDL
 *  - signer_whitelist is passed only when the mint is whitelist-ENABLED (else null → None)
 *  - COMPRESSION_LUT is optional (only used if the env var is set)
 *
 * Env: SYN_ENV_FILE, AMOUNT (human units), EVM_RECEIVER (0x...), [COMPRESSION_LUT]
 * Run: SYN_ENV_FILE=.env-synthesys-rwa AMOUNT=1 EVM_RECEIVER=0x... \
 *        ts-node scripts/svm/synthesys-token/8_bridge-send.ts
 */
import * as anchor from "@coral-xyz/anchor";
import {
  AccountMeta, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, sendAndConfirmTransaction, AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, createApproveInstruction, getAccount, getAssociatedTokenAddress,
  getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { CCIPClient, AddressConversion } from "../../../ccip-lib/svm";
import {
  findConfigPDA, findDestChainStatePDA, findNoncePDA, findFeeBillingSignerPDA, findFqConfigPDA,
  findFqDestChainPDA, findFqBillingTokenConfigPDA, findRMNRemoteCursesPDA, findRMNRemoteConfigPDA,
} from "../../../ccip-lib/svm/utils/pdas";
import { ChainId, getCCIPSVMConfig, CHAIN_SELECTORS } from "../../config";
import { loadEnv, loadWallet, programId, mintPk, whitelistEnabled, pdas } from "./_lib";

async function main() {
  loadEnv();
  const amountStr = process.env.AMOUNT;
  const evmReceiver = process.env.EVM_RECEIVER;
  if (!amountStr || !evmReceiver) throw new Error("Set AMOUNT and EVM_RECEIVER");
  const decimals = Number(process.env.SYN_TOKEN_DECIMALS || "18");

  const SYN = programId();
  const mint = mintPk();
  const config = getCCIPSVMConfig(ChainId.SOLANA_DEVNET);
  const connection: Connection = config.connection;
  const wallet = loadWallet();
  console.log("Wallet:", wallet.publicKey.toBase58(), "Mint:", mint.toBase58());

  const amount = new anchor.BN(Math.round(Number(amountStr) * 10 ** decimals).toString());
  console.log("Amount (base units):", amount.toString(), "-> EVM receiver:", evmReceiver);

  const userTokenAccount = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const [feeBillingSigner] = findFeeBillingSignerPDA(config.routerProgramId);

  console.log("\n[1] Delegating to fee-billing signer PDA (for CCIP burn)...");
  const acct = await getAccount(connection, userTokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (!(acct.delegate?.equals(feeBillingSigner) && acct.delegatedAmount >= BigInt(amount.toString()))) {
    const approveIx = createApproveInstruction(
      userTokenAccount, feeBillingSigner, wallet.publicKey, BigInt(amount.toString()), [], TOKEN_2022_PROGRAM_ID
    );
    const s = await sendAndConfirmTransaction(connection, new Transaction().add(approveIx), [wallet], { commitment: "confirmed" });
    console.log("  ✅ delegated tx:", s);
  } else console.log("  already delegated.");

  console.log("\n[2] Estimating fee...");
  const ccipClient = CCIPClient.create(connection, wallet, {
    ccipRouterProgramId: config.routerProgramId.toString(),
    feeQuoterProgramId: config.feeQuoterProgramId.toString(),
    rmnRemoteProgramId: config.rmnRemoteProgramId.toString(),
    linkTokenMint: config.linkTokenMint.toString(),
    tokenMint: mint.toString(),
    receiverProgramId: config.receiverProgramId.toString(),
  }, { logLevel: 2 as any });

  const receiverBytes = Buffer.from(AddressConversion.evmAddressToSolanaBytes(evmReceiver));
  const extraArgs = Buffer.from(ccipClient.createExtraArgs({ gasLimit: 0, allowOutOfOrderExecution: true }));
  const destChainSelector = new anchor.BN(CHAIN_SELECTORS[ChainId.ETHEREUM_SEPOLIA].toString());
  const message = { receiver: receiverBytes, data: Buffer.from([]), tokenAmounts: [{ token: mint, amount }], feeToken: PublicKey.default, extraArgs };
  const fee = await ccipClient.getFee({ destChainSelector, message } as any);
  console.log("  Estimated fee:", fee.amount.toNumber() / 1e9, "SOL");

  console.log("\n[3] Deriving ccipSend accounts (hook-aware)...");
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
  console.log(`  ${accountsToSave.length} remaining accts, ${lookupTableAddresses.length} LUT(s), tokenIndexes=${tokenIndexes}`);

  console.log("\n[4] Building ccipSend...");
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

  console.log("\n[5] Building pre/post bridge (synthesys)...");
  const synIdl = JSON.parse(fs.readFileSync("./target/idl/SynthesysToken.json", "utf-8"));
  synIdl.address = SYN.toBase58();
  const synProgram = new anchor.Program(synIdl as any, provider);

  const preIx = await (synProgram.methods as any).preBridgeSend().accounts({
    signer: wallet.publicKey,
    tokenConfig: pdas.tokenConfig(mint),
    mint,
    signerWhitelist: whitelistEnabled() ? pdas.whitelist(mint, wallet.publicKey) : null,
    signerBlocklist: pdas.blocklist(mint, wallet.publicKey),
    authorityPda: pdas.authority(mint),
    sourceTokenAccount: userTokenAccount,
    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  }).instruction();

  const postIx = await (synProgram.methods as any).postBridgeRestore().accounts({
    mint, tokenConfig: pdas.tokenConfig(mint), authorityPda: pdas.authority(mint), tokenProgram: TOKEN_2022_PROGRAM_ID,
  }).instruction();

  const computeBudgetIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

  const allLutAddresses = [...lookupTableAddresses];
  if (process.env.COMPRESSION_LUT) {
    const c = new PublicKey(process.env.COMPRESSION_LUT);
    if (!allLutAddresses.some((a) => a.equals(c))) allLutAddresses.push(c);
  } else {
    // Auto-create a SEPARATE, unregistered compression LUT holding the tx's static account
    // keys (the registered pool ALT only carries the 10 pool accounts). This shrinks the
    // versioned tx under the 1232-byte limit. Kept distinct from the pool ALT so its
    // writability never affects the router's pool-ALT validation.
    console.log("\n[5b] Creating compression LUT for static accounts...");
    const poolAlt = (await Promise.all(lookupTableAddresses.map((a) => connection.getAddressLookupTable(a))))
      .map((r) => r.value).filter(Boolean).flatMap((v) => v!.state.addresses.map((a) => a.toBase58()));
    const poolSet = new Set(poolAlt);
    const keys = new Map<string, PublicKey>();
    for (const ix of [preIx, sendIx, postIx]) {
      for (const k of ix.keys) if (!poolSet.has(k.pubkey.toBase58())) keys.set(k.pubkey.toBase58(), k.pubkey);
      keys.set(ix.programId.toBase58(), ix.programId);
    }
    const uniq = [...keys.values()];
    const slot = await connection.getSlot("finalized");
    const [createIx, lutAddr] = AddressLookupTableProgram.createLookupTable({ authority: wallet.publicKey, payer: wallet.publicKey, recentSlot: slot });
    await sendAndConfirmTransaction(connection, new Transaction().add(createIx), [wallet], { commitment: "confirmed" });
    for (let i = 0; i < uniq.length; i += 20) {
      const ext = AddressLookupTableProgram.extendLookupTable({ payer: wallet.publicKey, authority: wallet.publicKey, lookupTable: lutAddr, addresses: uniq.slice(i, i + 20) });
      await sendAndConfirmTransaction(connection, new Transaction().add(ext), [wallet], { commitment: "confirmed" });
    }
    console.log(`  compression LUT ${lutAddr.toBase58()} with ${uniq.length} addresses; warming up...`);
    // LUT must be one slot old before use; poll until it advances.
    const created = await connection.getSlot("confirmed");
    while ((await connection.getSlot("confirmed")) <= created + 1) await new Promise((r) => setTimeout(r, 400));
    allLutAddresses.push(lutAddr);
  }
  console.log("  LUTs:", allLutAddresses.map((a) => a.toBase58()).join(", ") || "(none)");
  const lutResults = await Promise.all(allLutAddresses.map((a) => connection.getAddressLookupTable(a)));
  const lookupTableAccounts = lutResults.map((r) => r.value).filter((v): v is NonNullable<typeof v> => v !== null);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey, recentBlockhash: blockhash,
    instructions: [preIx, computeBudgetIx, sendIx, postIx],
  }).compileToV0Message(lookupTableAccounts);
  const tx = new VersionedTransaction(messageV0);
  const size = tx.serialize().length;
  console.log(`  tx size: ${size} bytes (limit 1232)`);
  tx.sign([wallet]);

  console.log("\n[6] Simulating...");
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  if (sim.value.err) {
    console.log("Sim error:", JSON.stringify(sim.value.err));
    console.log("Logs:\n" + (sim.value.logs || []).join("\n"));
    throw new Error("Simulation failed.");
  }
  console.log("  Simulation OK.");

  // Resilient send: the public devnet RPC rate-limits (429), so resend the raw tx
  // periodically and poll signature status manually rather than relying on the
  // blockheight-exceedance strategy (which aborts on transient 429s).
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });
  console.log("  submitted:", sig, "- confirming...");
  let landed: any = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
      const s = st?.value;
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) { landed = s; break; }
      if (s?.err) { landed = s; break; }
      if (i % 5 === 4) { try { await connection.sendRawTransaction(raw, { skipPreflight: true }); } catch {} }
    } catch { /* 429/transient — keep polling */ }
  }
  const conf = { value: { err: landed ? landed.err : "timeout-unconfirmed" } };
  console.log("\n========================================");
  console.log(conf.value.err ? "❌ not confirmed: " + JSON.stringify(conf.value.err) : "✅ CCIP message sent!");
  console.log("Tx:", sig);
  console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  console.log("CCIP Explorer: https://ccip.chain.link/tx/" + sig);
  console.log("========================================");
}

main().catch((e) => { console.error("Error:", e.stack || e.message || e); process.exit(1); });
