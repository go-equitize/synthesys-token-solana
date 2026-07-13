/**
 * Whitelist a user on the deployed Sepolia RWA token and mint tokens to them.
 *
 * Run:
 *   USER_ADDRESS=<addr> AMOUNT=<token units> ts-node scripts/evm/rwa-token/whitelist-and-mint.ts
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });

const RWA_TOKEN = "0x4B5Ce0c64788b40fA8398C4fF7E0625D8116D524";
const WHITELIST = "0x7A482C7af3E696358490e47C231cB14D151E5f33";

const RWA_TOKEN_ABI = [
  "function mint(address account, uint256 amount) external",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
];
const WHITELIST_ABI = [
  "function addWhitelistAccount(address account) external",
  "function isWhitelisted(address account) view returns (bool)",
];

async function main() {
  const userAddress = process.env.USER_ADDRESS;
  if (!userAddress) throw new Error("Set USER_ADDRESS env var");
  const amountStr = process.env.AMOUNT;
  if (!amountStr) throw new Error("Set AMOUNT env var (in token units, e.g. 1000)");

  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, provider);
  console.log("Wallet:", await wallet.getAddress());

  const rwa = new ethers.Contract(RWA_TOKEN, RWA_TOKEN_ABI, wallet);
  const whitelist = new ethers.Contract(WHITELIST, WHITELIST_ABI, wallet);

  console.log("\n[1] Whitelisting", userAddress, "...");
  const alreadyWhitelisted = await whitelist.isWhitelisted(userAddress);
  if (alreadyWhitelisted) {
    console.log("  ⏭️  Already whitelisted.");
  } else {
    const wlTx = await whitelist.addWhitelistAccount(userAddress);
    await wlTx.wait();
    console.log("  ✅ Whitelisted. tx:", wlTx.hash);
  }

  const decimals = await rwa.decimals();
  const rawAmount = ethers.parseUnits(amountStr, decimals);

  console.log("\n[2] Minting", amountStr, "tokens to", userAddress, "...");
  const mintTx = await rwa.mint(userAddress, rawAmount);
  await mintTx.wait();
  console.log("  ✅ Minted. tx:", mintTx.hash);

  const balance = await rwa.balanceOf(userAddress);
  console.log("\n🎉 Done. New balance:", ethers.formatUnits(balance, decimals));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
