/**
 * Generic Solana Devnet -> EVM (Sepolia) CCIP token transfer.
 *
 * Token-agnostic: works for any Token-2022 mint whose CCIP pool + admin registry are
 * already wired up on both chains (RWA, z-token, ...).
 *
 * Flow (README.md §7 "Solana -> EVM"):
 *   1. Delegate the sender's token account to the CCIP fee-billing signer PDA
 *      (ccip_send burns via that delegation, mirroring the EVM approve-then-burn flow).
 *   2. Call router.ccipSend via the ccip-lib/svm CCIPClient, paying the fee in native SOL.
 *
 * Env:
 *   SOLANA_RPC_URL, ANCHOR_WALLET   (optional, default devnet + ~/.config/solana/id.json)
 *   TOKEN_MINT                      Solana Token-2022 mint to bridge (required)
 *   TOKEN_DECIMALS                  mint decimals, default 6
 *   AMOUNT                          human units, e.g. "0.01" (required)
 *   EVM_RECEIVER                    0x... EVM recipient (required)
 *   GAS_LIMIT                       default 0 (token-only transfer to an EOA)
 *
 * Run:
 *   TOKEN_MINT=... AMOUNT=0.01 EVM_RECEIVER=0x... ts-node scripts/svm/router/transfer-to-evm.ts
 */
import * as anchor from "@coral-xyz/anchor";
import {
  AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createApproveInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { CCIPClient, AddressConversion } from "../../../ccip-lib/svm";
import {
  findConfigPDA,
  findDestChainStatePDA,
  findNoncePDA,
  findFeeBillingSignerPDA,
  findFqConfigPDA,
  findFqDestChainPDA,
  findFqBillingTokenConfigPDA,
  findRMNRemoteCursesPDA,
  findRMNRemoteConfigPDA,
} from "../../../ccip-lib/svm/utils/pdas";
import { ChainId, getCCIPSVMConfig, CHAIN_SELECTORS } from "../../config";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env-rwa", override: false });

async function main() {
  const mintAddress = process.env.TOKEN_MINT;
  const amountStr = process.env.AMOUNT;
  const evmReceiver = process.env.EVM_RECEIVER;
  if (!mintAddress || !amountStr || !evmReceiver) {
    throw new Error("Set TOKEN_MINT, AMOUNT, EVM_RECEIVER");
  }
  const decimals = Number(process.env.TOKEN_DECIMALS || "6");
  const gasLimit = Number(process.env.GAS_LIMIT || "0");

  const config = getCCIPSVMConfig(ChainId.SOLANA_DEVNET);
  const connection: Connection = config.connection;

  const walletPath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
  const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));
  console.log("Wallet:", wallet.publicKey.toBase58());

  const mint = new PublicKey(mintAddress);
  const amount = new anchor.BN(Math.round(Number(amountStr) * 10 ** decimals).toString());
  console.log("Mint:", mint.toBase58(), `(${decimals} dp)`);
  console.log("Amount (base units):", amount.toString());
  console.log("EVM receiver:", evmReceiver);

  const userTokenAccount = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const [feeBillingSigner] = findFeeBillingSignerPDA(config.routerProgramId);

  console.log("\n[1] Checking delegation to fee-billing signer PDA...");
  const accountInfo = await getAccount(connection, userTokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
  const alreadyDelegated =
    accountInfo.delegate?.equals(feeBillingSigner) && accountInfo.delegatedAmount >= BigInt(amount.toString());

  if (!alreadyDelegated) {
    console.log("Delegating", amount.toString(), "to", feeBillingSigner.toBase58());
    const approveIx = createApproveInstruction(
      userTokenAccount,
      feeBillingSigner,
      wallet.publicKey,
      BigInt(amount.toString()),
      [],
      TOKEN_2022_PROGRAM_ID
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(approveIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
    console.log("✅ Delegated. tx:", sig);
  } else {
    console.log("Already sufficiently delegated.");
  }

  console.log("\n[2] Estimating fee...");
  const ccipClient = CCIPClient.create(
    connection,
    wallet,
    {
      ccipRouterProgramId: config.routerProgramId.toString(),
      feeQuoterProgramId: config.feeQuoterProgramId.toString(),
      rmnRemoteProgramId: config.rmnRemoteProgramId.toString(),
      linkTokenMint: config.linkTokenMint.toString(),
      tokenMint: mint.toString(),
      receiverProgramId: config.receiverProgramId.toString(),
    },
    { logLevel: 2 as any }
  );

  // Anchor's IDL-based borsh coder requires real Buffers for "bytes" fields, not plain Uint8Arrays.
  const receiverBytes = Buffer.from(AddressConversion.evmAddressToSolanaBytes(evmReceiver));
  const extraArgs = Buffer.from(ccipClient.createExtraArgs({ gasLimit, allowOutOfOrderExecution: true }));

  const destChainSelector = new anchor.BN(CHAIN_SELECTORS[ChainId.ETHEREUM_SEPOLIA].toString());
  const tokenAmounts = [{ token: mint, amount }];
  const feeToken = PublicKey.default; // native SOL
  const message = { receiver: receiverBytes, data: Buffer.from([]), tokenAmounts, feeToken, extraArgs };

  const fee = await ccipClient.getFee({ destChainSelector, message } as any);
  console.log("Estimated fee:", fee.amount.toNumber() / 1e9, "SOL");

  // ---------------------------------------------------------------------
  // The vendored ccip-lib/svm SDK builds ccipSend's remaining accounts from
  // a hardcoded 10-entry ALT layout, which has no notion of Token-2022
  // TransferHook extra accounts and fails with "An account required by the
  // instruction is missing" for hook-gated mints (rwa-token/z-token both
  // are). The router's on-chain `derive_accounts_ccip_send` instruction is
  // the documented, hook-aware way to build this list: call it repeatedly
  // (each call simulated, never sent) until `next_stage` is empty, feeding
  // `ask_again_with` back in as remaining_accounts each time.
  // ---------------------------------------------------------------------
  console.log("\n[3] Deriving accounts for ccipSend (hook-aware)...");
  const routerIdl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../../ccip-lib/svm/idl/ccip_router.json"), "utf-8")
  );
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
    const result: any = await routerProgram.methods
      .deriveAccountsCcipSend(deriveParams, stage)
      .accounts({ config: configPda })
      .remainingAccounts(remainingAccounts)
      .view();

    console.log(`  stage="${result.currentStage}" -> +${result.accountsToSave.length} accounts, next="${result.nextStage}"`);

    if (typeof result.currentStage === "string" && /^TokenTransferStaticAccounts\/\d+\/0$/.test(result.currentStage)) {
      tokenIndexes.push(accountsToSave.length);
    }

    for (const a of result.accountsToSave) {
      accountsToSave.push({ pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable });
    }
    for (const lut of result.lookUpTablesToSave) {
      lookupTableAddresses.push(lut);
    }

    if (!result.nextStage) break;
    stage = result.nextStage;
    remainingAccounts = result.askAgainWith.map((a: any) => ({
      pubkey: a.pubkey,
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    }));
  }

  console.log(`  Derived ${accountsToSave.length} remaining accounts, ${lookupTableAddresses.length} lookup table(s), tokenIndexes=${tokenIndexes}`);

  console.log("\n[4] Sending ccipSend...");
  const selectorBigInt = BigInt(destChainSelector.toString());
  const feeTokenMint = NATIVE_MINT; // paying fee in native SOL
  const [destChainState] = findDestChainStatePDA(selectorBigInt, config.routerProgramId);
  const [nonce] = findNoncePDA(selectorBigInt, wallet.publicKey, config.routerProgramId);
  const [feeQuoterConfig] = findFqConfigPDA(config.feeQuoterProgramId);
  const [fqDestChain] = findFqDestChainPDA(selectorBigInt, config.feeQuoterProgramId);
  const [fqBillingTokenConfig] = findFqBillingTokenConfigPDA(feeTokenMint, config.feeQuoterProgramId);
  const [fqLinkBillingTokenConfig] = findFqBillingTokenConfigPDA(config.linkTokenMint, config.feeQuoterProgramId);
  const [rmnRemoteCurses] = findRMNRemoteCursesPDA(config.rmnRemoteProgramId);
  const [rmnRemoteConfig] = findRMNRemoteConfigPDA(config.rmnRemoteProgramId);
  const feeBillingSignerFeeTokenAccount = await getAssociatedTokenAddress(
    feeTokenMint,
    feeBillingSigner,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const sendIx = await routerProgram.methods
    .ccipSend(destChainSelector, message, Buffer.from(tokenIndexes))
    .accounts({
      authority: wallet.publicKey,
      config: configPda,
      destChainState,
      nonce,
      systemProgram: anchor.web3.SystemProgram.programId,
      feeTokenProgram: TOKEN_PROGRAM_ID,
      feeTokenMint,
      feeTokenUserAssociatedAccount: PublicKey.default, // native SOL fee: no user ATA
      feeTokenReceiver: feeBillingSignerFeeTokenAccount,
      feeBillingSigner,
      feeQuoter: config.feeQuoterProgramId,
      feeQuoterConfig,
      feeQuoterDestChain: fqDestChain,
      feeQuoterBillingTokenConfig: fqBillingTokenConfig,
      feeQuoterLinkTokenConfig: fqLinkBillingTokenConfig,
      rmnRemote: config.rmnRemoteProgramId,
      rmnRemoteCurses,
      rmnRemoteConfig,
    } as any)
    .remainingAccounts(accountsToSave)
    .instruction();

  console.log(`  Lookup tables to resolve: ${lookupTableAddresses.map((a) => a.toBase58()).join(", ")}`);
  const lookupTableResults = await Promise.all(
    lookupTableAddresses.map((addr) => connection.getAddressLookupTable(addr))
  );
  lookupTableResults.forEach((r, i) => {
    console.log(`  LUT[${i}] ${lookupTableAddresses[i].toBase58()}: ${r.value ? `${r.value.state.addresses.length} addresses` : "NOT FOUND"}`);
  });
  const lookupTableAccounts = lookupTableResults.map((r) => r.value).filter((v): v is NonNullable<typeof v> => v !== null);

  const computeBudgetIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [computeBudgetIx, sendIx],
  }).compileToV0Message(lookupTableAccounts);
  const tx = new VersionedTransaction(messageV0);
  tx.sign([wallet]);

  console.log("\n[5] Simulating before sending...");
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  if (sim.value.err) {
    console.log("Simulation error:", JSON.stringify(sim.value.err));
    console.log("Logs:\n" + (sim.value.logs || []).join("\n"));
    throw new Error("Simulation failed, aborting before real send.");
  }
  console.log("Simulation OK. Logs:\n" + (sim.value.logs || []).join("\n"));

  const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

  console.log("\n========================================");
  console.log("✅ CCIP message sent!");
  console.log("Tx signature:", sig);
  console.log(`Explorer (tx): https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  console.log("========================================");
}

main().catch((e) => {
  console.error("Error:", e.stack || e.message || e);
  process.exit(1);
});
