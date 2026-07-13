/**
 * Generic EVM (Sepolia) -> Solana Devnet CCIP token transfer.
 *
 * Token-agnostic: works for RWA, ZToken (zEPH), or any CCIP-enabled ERC-20 on Sepolia,
 * as long as its pool + admin registry are already wired up on both chains.
 *
 * Recipe: FRONTEND_BRIDGE_SEND_GUIDE.md (SVMExtraArgsV1 encoding, message shape, send flow).
 *
 * Env:
 *   EVM_PRIVATE_KEY, EVM_RPC_URL   (required, from .env)
 *   TOKEN_ADDRESS                  ERC-20 to bridge (required)
 *   TOKEN_DECIMALS                 default 18
 *   AMOUNT                         human units, e.g. "0.01" (required)
 *   SOLANA_RECIPIENT               base58 Solana wallet (required)
 *   FEE_TOKEN                      "link" (default) or "native"
 *   LINK_TOKEN_ADDRESS             default Sepolia LINK
 *   ROUTER_ADDRESS                 default Sepolia CCIP router
 *
 * Run:
 *   TOKEN_ADDRESS=0x... AMOUNT=0.01 SOLANA_RECIPIENT=... ts-node scripts/evm/router/transfer-to-solana.ts
 */
import { ethers } from "ethers";
import bs58 from "bs58";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });

const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59";
const LINK_TOKEN = process.env.LINK_TOKEN_ADDRESS || "0x779877A7B0D9E8603169DdbD7836e478b4624789";
const SOLANA_DEVNET_SELECTOR = BigInt("16423721717087811551");
const SVM_EXTRA_ARGS_V1_TAG = "0x1f3b3aba";

function solanaAddressToBytes32(addr: string): string {
  return "0x" + Buffer.from(bs58.decode(addr)).toString("hex");
}

function buildSolanaExtraArgs(tokenReceiverBase58: string): string {
  const computeUnits = 0;
  const accountIsWritableBitmap = BigInt(0);
  const allowOutOfOrderExecution = true;
  const tokenReceiver = solanaAddressToBytes32(tokenReceiverBase58);
  const accounts: string[] = [];
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint32,uint64,bool,bytes32,bytes32[])"],
    [[computeUnits, accountIsWritableBitmap, allowOutOfOrderExecution, tokenReceiver, accounts]]
  );
  return SVM_EXTRA_ARGS_V1_TAG + encoded.slice(2);
}

const ROUTER_ABI = [
  "function getFee(uint64 destinationChainSelector, (bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs) message) view returns (uint256)",
  "function ccipSend(uint64 destinationChainSelector, (bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs) message) payable returns (bytes32)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const amountStr = process.env.AMOUNT;
  const solanaRecipient = process.env.SOLANA_RECIPIENT;
  if (!tokenAddress || !amountStr || !solanaRecipient) {
    throw new Error("Set TOKEN_ADDRESS, AMOUNT, SOLANA_RECIPIENT");
  }
  const decimals = Number(process.env.TOKEN_DECIMALS || "18");
  const useNativeFee = (process.env.FEE_TOKEN || "link").toLowerCase() === "native";

  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, provider);
  const sender = await wallet.getAddress();
  console.log("Sender:", sender);
  console.log("Token:", tokenAddress, `(${decimals} dp)`);
  console.log("Amount:", amountStr);
  console.log("Solana recipient:", solanaRecipient);

  const amount = ethers.parseUnits(amountStr, decimals);
  const feeToken = useNativeFee ? ethers.ZeroAddress : LINK_TOKEN;

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

  const message = {
    receiver: ethers.ZeroHash,
    data: "0x",
    tokenAmounts: [{ token: tokenAddress, amount }],
    feeToken,
    extraArgs: buildSolanaExtraArgs(solanaRecipient),
  };

  console.log("\n[1] Estimating fee...");
  const fee: bigint = await router.getFee(SOLANA_DEVNET_SELECTOR, message);
  console.log("Fee:", useNativeFee ? ethers.formatEther(fee) + " ETH" : ethers.formatEther(fee) + " LINK");

  console.log("\n[2] Checking/approving token allowance...");
  if ((await token.allowance(sender, ROUTER_ADDRESS)) < amount) {
    const tx = await token.approve(ROUTER_ADDRESS, amount);
    await tx.wait();
    console.log("Token approved. tx:", tx.hash);
  } else {
    console.log("Sufficient allowance already set.");
  }

  if (!useNativeFee) {
    console.log("\n[3] Checking/approving LINK allowance for fee...");
    const link = new ethers.Contract(LINK_TOKEN, ERC20_ABI, wallet);
    const feeWithHeadroom = (fee * BigInt(12)) / BigInt(10);
    if ((await link.allowance(sender, ROUTER_ADDRESS)) < feeWithHeadroom) {
      const tx = await link.approve(ROUTER_ADDRESS, feeWithHeadroom);
      await tx.wait();
      console.log("LINK approved. tx:", tx.hash);
    } else {
      console.log("Sufficient LINK allowance already set.");
    }
  }

  const txValue = useNativeFee ? fee : BigInt(0);
  console.log("\n[4] Getting messageId via static call...");
  const messageId: string = await router.ccipSend.staticCall(SOLANA_DEVNET_SELECTOR, message, { value: txValue });

  console.log("\n[5] Sending ccipSend...");
  const tx = await router.ccipSend(SOLANA_DEVNET_SELECTOR, message, { value: txValue });
  const receipt = await tx.wait();

  console.log("\n========================================");
  console.log("✅ CCIP message sent!");
  console.log("Message ID:", messageId);
  console.log("Tx hash:", receipt!.hash);
  console.log("Explorer:", `https://ccip.chain.link/msg/${messageId}`);
  console.log("========================================");
}

main().catch((e) => {
  console.error("Error:", e.message || e);
  process.exit(1);
});
