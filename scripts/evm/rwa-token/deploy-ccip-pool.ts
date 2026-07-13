/**
 * Deploy EVM BurnMintTokenPool for RWA token on Sepolia and wire it into CCIP.
 *
 * Steps performed:
 *   1. Deploy BurnMintTokenPool
 *   2. Enable Solana Devnet as remote chain (with pool signer PDA + mint as remote addresses)
 *   3. Grant MINTER_ROLE + BURNER_ROLE to pool
 *   4. Whitelist pool on RWA token
 *   5. Register admin via RegistryModuleOwnerCustom
 *   6. Accept admin role in TokenAdminRegistry
 *   7. Set pool in TokenAdminRegistry
 *
 * Run:
 *   ts-node scripts/evm/rwa-token/deploy-ccip-pool.ts
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });

// ── Sepolia CCIP infrastructure ────────────────────────────────────────────
const CCIP_ROUTER          = "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59";
const RMN_PROXY            = "0xba3f6251de62dED61Ff98590cB2fDf6871FbB991";
const TOKEN_ADMIN_REGISTRY = "0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82";
const REGISTRY_MODULE      = "0x62e731218d0D47305aba2BE3751E7EE9E5520790";

// ── RWA token (already deployed on Sepolia) ───────────────────────────────
const RWA_TOKEN = "0x4B5Ce0c64788b40fA8398C4fF7E0625D8116D524";
const WHITELIST = "0x7A482C7af3E696358490e47C231cB14D151E5f33";

// ── Solana Devnet pool info ───────────────────────────────────────────────
// Pool signer PDA = BWsChXGiw9ZAZ4xB6ELNpbz7oxmqcmLwXvuEGv6JhCko (32 bytes)
// Mint address    = 7jwyUuyZzdJNmkeQZNwnCXTEdVTgtu4gqgxgkiccMhb1 (32 bytes)
const SOLANA_POOL_SIGNER_B58 = "BWsChXGiw9ZAZ4xB6ELNpbz7oxmqcmLwXvuEGv6JhCko";
const SOLANA_MINT_B58        = "7jwyUuyZzdJNmkeQZNwnCXTEdVTgtu4gqgxgkiccMhb1";
const SOLANA_DEVNET_SELECTOR = BigInt("16423721717087811551");

// ── ABIs ──────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function MINTER_ROLE() view returns (bytes32)",
  "function BURNER_ROLE() view returns (bytes32)",
];
const WHITELIST_ABI = [
  "function addWhitelistAccount(address account) external",
];
const REGISTRY_MODULE_ABI = [
  "function registerAdminViaOwner(address token) external",
];
const TOKEN_ADMIN_REGISTRY_ABI = [
  "function acceptAdminRole(address localToken) external",
  "function setPool(address localToken, address pool) external",
];
const RATE_LIMITER_CONFIG = {
  isEnabled: false,
  capacity: 0,
  rate: 0,
};

function base58ToBytes(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const alphabetMap: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) alphabetMap[ALPHABET[i]] = i;
  let bytes = [0];
  for (const char of str) {
    let carry = alphabetMap[char];
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const char of str) { if (char === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, provider);
  console.log("Wallet:", await wallet.getAddress());
  console.log("ETH balance:", ethers.formatEther(await provider.getBalance(wallet.address)));

  // Load compiled BurnMintTokenPool bytecode
  const bytecodeHex = fs.readFileSync(
    path.join(__dirname, "../../../node_modules_cache/BurnMintTokenPool.bin"), "utf-8"
  ).trim();
  // Fallback to absolute path
  const bytecode = "0x" + (bytecodeHex.startsWith("0x") ? bytecodeHex.slice(2) : bytecodeHex);

  const abi = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../../node_modules_cache/BurnMintTokenPool.abi"), "utf-8"
    )
  );

  // 1. Deploy BurnMintTokenPool
  console.log("\n[1] Deploying BurnMintTokenPool...");
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const pool = await factory.deploy(
    RWA_TOKEN,    // token
    [],           // allowlist (open)
    RMN_PROXY,    // rmnProxy
    CCIP_ROUTER,  // router
  );
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log("✅ Pool deployed:", poolAddress);

  // 2. Configure Solana Devnet as remote chain
  console.log("\n[2] Configuring remote chain (Solana Devnet)...");
  const poolSignerBytes = base58ToBytes(SOLANA_POOL_SIGNER_B58);
  const mintBytes = base58ToBytes(SOLANA_MINT_B58);

  const chainUpdate = {
    remoteChainSelector: SOLANA_DEVNET_SELECTOR,
    allowed: true,
    remotePoolAddress: poolSignerBytes,
    remoteTokenAddress: mintBytes,
    outboundRateLimiterConfig: RATE_LIMITER_CONFIG,
    inboundRateLimiterConfig: RATE_LIMITER_CONFIG,
  };
  const applyChainTx = await (pool as any).applyChainUpdates([chainUpdate]);
  await applyChainTx.wait();
  console.log("✅ Solana Devnet remote chain configured. tx:", applyChainTx.hash);

  // 3. Grant roles to pool on RWA token
  console.log("\n[3] Granting MINTER_ROLE and BURNER_ROLE to pool...");
  const rwa = new ethers.Contract(RWA_TOKEN, ERC20_ABI, wallet);
  const minterRole = await rwa.MINTER_ROLE();
  const burnerRole = await rwa.BURNER_ROLE();
  const grantMinterTx = await rwa.grantRole(minterRole, poolAddress);
  await grantMinterTx.wait();
  const grantBurnerTx = await rwa.grantRole(burnerRole, poolAddress);
  await grantBurnerTx.wait();
  console.log("✅ MINTER_ROLE and BURNER_ROLE granted to pool");

  // 4. Whitelist pool
  console.log("\n[4] Whitelisting pool on RWA token...");
  const whitelist = new ethers.Contract(WHITELIST, WHITELIST_ABI, wallet);
  const whitelistTx = await whitelist.addWhitelistAccount(poolAddress);
  await whitelistTx.wait();
  console.log("✅ Pool whitelisted. tx:", whitelistTx.hash);

  // 5. Register admin
  console.log("\n[5] Registering admin via RegistryModuleOwnerCustom...");
  const registryModule = new ethers.Contract(REGISTRY_MODULE, REGISTRY_MODULE_ABI, wallet);
  const registerTx = await registryModule.registerAdminViaOwner(RWA_TOKEN);
  await registerTx.wait();
  console.log("✅ Admin registered. tx:", registerTx.hash);

  // 6. Accept admin role
  console.log("\n[6] Accepting admin role in TokenAdminRegistry...");
  const tar = new ethers.Contract(TOKEN_ADMIN_REGISTRY, TOKEN_ADMIN_REGISTRY_ABI, wallet);
  const acceptTx = await tar.acceptAdminRole(RWA_TOKEN);
  await acceptTx.wait();
  console.log("✅ Admin role accepted. tx:", acceptTx.hash);

  // 7. Set pool
  console.log("\n[7] Setting pool in TokenAdminRegistry...");
  const setPoolTx = await tar.setPool(RWA_TOKEN, poolAddress);
  await setPoolTx.wait();
  console.log("✅ Pool set in registry. tx:", setPoolTx.hash);

  console.log("\n========================================");
  console.log("EVM POOL ADDRESS:", poolAddress);
  console.log("========================================");

  // Append to .env file for reference
  fs.appendFileSync(".env", `\nEVM_POOL_ADDRESS=${poolAddress}\n`);
  console.log("Saved EVM_POOL_ADDRESS to .env");
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
