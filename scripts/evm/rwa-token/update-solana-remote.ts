/**
 * Repoint the existing EVM BurnMintTokenPool's Solana-Devnet remote at a NEW
 * Solana mint + pool signer (used after creating a fresh Solana mint).
 *
 * The pool's applyChainUpdates(ChainUpdate[]) uses an `allowed` bool, and re-adding
 * an existing chain reverts — so we remove the stale config, then add the new one.
 *
 * Env:
 *   EVM_PRIVATE_KEY, EVM_RPC_URL           (required)
 *   EVM_POOL_ADDRESS   default 0x635DCe72a9d113010cdBb24cF44431845Df09a51
 *   RWA_MINT_ADDRESS   new Solana mint (base58)
 *   SOL_POOL_SIGNER    new Solana pool signer PDA (base58)
 *
 * Run: ts-node scripts/evm/rwa-token/update-solana-remote.ts
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env-rwa", override: false });

const EVM_POOL = process.env.EVM_POOL_ADDRESS || "0x635DCe72a9d113010cdBb24cF44431845Df09a51";
const SOLANA_DEVNET_SELECTOR = BigInt("16423721717087811551");
const NEW_MINT_B58 = process.env.RWA_MINT_ADDRESS!;
const NEW_POOL_SIGNER_B58 = process.env.SOL_POOL_SIGNER!;
const RATE = { isEnabled: false, capacity: BigInt(0), rate: BigInt(0) };

function base58ToBytes(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]] = i;
  let bytes = [0];
  for (const ch of str) {
    let carry = map[ch];
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of str) { if (ch === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}
const toHex = (b58: string) => "0x" + Buffer.from(base58ToBytes(b58)).toString("hex");

async function main() {
  if (!NEW_MINT_B58 || !NEW_POOL_SIGNER_B58)
    throw new Error("Set RWA_MINT_ADDRESS and SOL_POOL_SIGNER");

  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, provider);
  const abi = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../../node_modules_cache/BurnMintTokenPool.abi"), "utf-8")
  );
  const pool = new ethers.Contract(EVM_POOL, abi, wallet);

  const remotePool = toHex(NEW_POOL_SIGNER_B58);
  const remoteToken = toHex(NEW_MINT_B58);
  console.log("EVM pool:        ", EVM_POOL);
  console.log("New remote pool: ", NEW_POOL_SIGNER_B58, remotePool);
  console.log("New remote token:", NEW_MINT_B58, remoteToken);

  if (await pool.isSupportedChain(SOLANA_DEVNET_SELECTOR)) {
    console.log("\nRemoving stale Solana config...");
    const rm = await pool.applyChainUpdates([{
      remoteChainSelector: SOLANA_DEVNET_SELECTOR, allowed: false,
      remotePoolAddress: "0x", remoteTokenAddress: "0x",
      outboundRateLimiterConfig: RATE, inboundRateLimiterConfig: RATE,
    }]);
    await rm.wait();
    console.log("✅ removed. tx:", rm.hash);
  }

  console.log("\nAdding new Solana config...");
  const add = await pool.applyChainUpdates([{
    remoteChainSelector: SOLANA_DEVNET_SELECTOR, allowed: true,
    remotePoolAddress: remotePool, remoteTokenAddress: remoteToken,
    outboundRateLimiterConfig: RATE, inboundRateLimiterConfig: RATE,
  }]);
  await add.wait();
  console.log("✅ added. tx:", add.hash);

  console.log("\nVerify:");
  console.log("  isSupportedChain:", await pool.isSupportedChain(SOLANA_DEVNET_SELECTOR));
  console.log("  getRemoteToken:  ", await pool.getRemoteToken(SOLANA_DEVNET_SELECTOR));
}

main().catch((e) => { console.error(e); process.exit(1); });
