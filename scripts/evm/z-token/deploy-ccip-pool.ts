/**
 * Deploy EVM BurnMintTokenPool for the ZToken (zEPH) on Sepolia and wire it into CCIP.
 *
 * Mirrors scripts/evm/rwa-token/deploy-ccip-pool.ts, adapted for ZToken:
 *   - ZToken is blocklist-only: no whitelist step
 *   - Admin registration via RegistryModuleOwnerCustom.registerAdminViaOwner
 *     (wallet is ZToken's owner())
 *
 * Steps:
 *   1. Deploy BurnMintTokenPool(zEPH, [], RMN, Router)
 *   2. applyChainUpdates: enable Solana Devnet remote (pool signer PDA + mint)
 *   3. Grant MINTER_ROLE + BURNER_ROLE to pool on ZToken
 *   4. registerAdminViaOwner -> acceptAdminRole -> setPool
 *
 * Env:
 *   EVM_PRIVATE_KEY, EVM_RPC_URL          (required)
 *   Z_EVM_TOKEN     default zEPH proxy on Sepolia
 *   Z_SOL_POOL_SIGNER, Z_MINT_ADDRESS     Solana-side addresses (required)
 *
 * Run: ts-node scripts/evm/z-token/deploy-ccip-pool.ts
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env-z", override: false });

const CCIP_ROUTER          = "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59";
const RMN_PROXY            = "0xba3f6251de62dED61Ff98590cB2fDf6871FbB991";
const TOKEN_ADMIN_REGISTRY = "0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82";
const REGISTRY_MODULE      = "0x62e731218d0D47305aba2BE3751E7EE9E5520790";

const Z_TOKEN = process.env.Z_EVM_TOKEN || "0x706639a9c19a3dec456797b682371b0d8bdda815";
const SOLANA_POOL_SIGNER_B58 = process.env.Z_SOL_POOL_SIGNER!;
const SOLANA_MINT_B58 = process.env.Z_MINT_ADDRESS!;
const SOLANA_DEVNET_SELECTOR = BigInt("16423721717087811551");

const ERC20_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function BURNER_ROLE() view returns (bytes32)",
  "function owner() view returns (address)",
];
const REGISTRY_MODULE_ABI = ["function registerAdminViaOwner(address token) external"];
const TOKEN_ADMIN_REGISTRY_ABI = [
  "function acceptAdminRole(address localToken) external",
  "function setPool(address localToken, address pool) external",
  "function getTokenConfig(address token) view returns (tuple(address administrator, address pendingAdministrator, address tokenPool))",
];
const RATE_LIMITER_CONFIG = { isEnabled: false, capacity: 0, rate: 0 };

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

async function main() {
  if (!SOLANA_POOL_SIGNER_B58 || !SOLANA_MINT_B58) {
    throw new Error("Set Z_SOL_POOL_SIGNER and Z_MINT_ADDRESS (or populate .env-z)");
  }
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, provider);
  console.log("Wallet:", await wallet.getAddress());
  console.log("ZToken:", Z_TOKEN);
  console.log("Solana pool signer:", SOLANA_POOL_SIGNER_B58);
  console.log("Solana mint:", SOLANA_MINT_B58);

  const bytecodeHex = fs
    .readFileSync(path.join(__dirname, "../../../node_modules_cache/BurnMintTokenPool.bin"), "utf-8")
    .trim();
  const bytecode = "0x" + (bytecodeHex.startsWith("0x") ? bytecodeHex.slice(2) : bytecodeHex);
  const abi = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../../node_modules_cache/BurnMintTokenPool.abi"), "utf-8")
  );

  console.log("\n[1] Deploying BurnMintTokenPool...");
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const pool = await factory.deploy(Z_TOKEN, [], RMN_PROXY, CCIP_ROUTER);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log("✅ Pool deployed:", poolAddress);

  console.log("\n[2] Configuring Solana Devnet remote chain...");
  const chainUpdate = {
    remoteChainSelector: SOLANA_DEVNET_SELECTOR,
    allowed: true,
    remotePoolAddress: base58ToBytes(SOLANA_POOL_SIGNER_B58),
    remoteTokenAddress: base58ToBytes(SOLANA_MINT_B58),
    outboundRateLimiterConfig: RATE_LIMITER_CONFIG,
    inboundRateLimiterConfig: RATE_LIMITER_CONFIG,
  };
  const applyTx = await (pool as any).applyChainUpdates([chainUpdate]);
  await applyTx.wait();
  console.log("✅ Remote chain configured. tx:", applyTx.hash);

  console.log("\n[3] Granting MINTER_ROLE + BURNER_ROLE to pool on ZToken...");
  const ztoken = new ethers.Contract(Z_TOKEN, ERC20_ABI, wallet);
  const minterRole = await ztoken.MINTER_ROLE();
  const burnerRole = await ztoken.BURNER_ROLE();
  await (await ztoken.grantRole(minterRole, poolAddress)).wait();
  await (await ztoken.grantRole(burnerRole, poolAddress)).wait();
  console.log("✅ Roles granted.");

  console.log("\n[4] Registering admin via RegistryModuleOwnerCustom...");
  const registryModule = new ethers.Contract(REGISTRY_MODULE, REGISTRY_MODULE_ABI, wallet);
  await (await registryModule.registerAdminViaOwner(Z_TOKEN)).wait();
  console.log("✅ Admin registered.");

  console.log("\n[5] Accepting admin role...");
  const tar = new ethers.Contract(TOKEN_ADMIN_REGISTRY, TOKEN_ADMIN_REGISTRY_ABI, wallet);
  await (await tar.acceptAdminRole(Z_TOKEN)).wait();
  console.log("✅ Admin role accepted.");

  console.log("\n[6] Setting pool in TokenAdminRegistry...");
  await (await tar.setPool(Z_TOKEN, poolAddress)).wait();
  console.log("✅ Pool set.");

  const cfg = await tar.getTokenConfig(Z_TOKEN);
  console.log("\nRegistry config — administrator:", cfg.administrator, "pool:", cfg.tokenPool);

  fs.appendFileSync(".env-z", `Z_EVM_POOL_ADDRESS=${poolAddress}\n`);
  console.log("\n========================================");
  console.log("Z EVM POOL ADDRESS:", poolAddress);
  console.log("Saved Z_EVM_POOL_ADDRESS to .env-z");
  console.log("========================================");
}

main().catch((e) => {
  console.error("Error:", e.message || e);
  process.exit(1);
});
