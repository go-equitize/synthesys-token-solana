/**
 * Diagnose why inbound (Solana->Sepolia) CCIP execution fails on the EVM side.
 * Read-only. Checks pool wiring, roles, remote config, and whitelist.
 *
 * Run: ts-node scripts/evm/rwa-token/diagnose-inbound.ts
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env-rwa", override: false });

const EVM_POOL = process.env.EVM_POOL_ADDRESS || "0x635DCe72a9d113010cdBb24cF44431845Df09a51";
const RWA_TOKEN = "0x4B5Ce0c64788b40fA8398C4fF7E0625D8116D524";
const WHITELIST = "0x7A482C7af3E696358490e47C231cB14D151E5f33";
const SEPOLIA_CCIP_ROUTER = "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59";
const SOL_SELECTOR = BigInt("16423721717087811551");

// Expected Solana-side A53U values
const A53U_MINT_B58 = "A53UBBndVC7XT9TKTDjmswT2Sm9AMbaDwEJBQU8UhAdp";
const A53U_STATE_PDA_B58 = "GhPBSwDcvHKJbn5wvT8BSVjD8h7L7u6trsxygZiNFVti";  // correct remotePool
const A53U_SIGNER_PDA_B58 = "Ejeh9tLXZcbDqJQz8gsSdJauXJCyjEo9FGwYfZuoLJ4z"; // WRONG for remotePool

// The receiver used in our test sends
const TEST_RECEIVER = "0x4B5Ce0c64788b40fA8398C4fF7E0625D8116D524";

function base58ToBytes(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]] = i;
  let bytes = [0];
  for (const ch of str) {
    let carry = map[ch];
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of str) { if (ch === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}
const toHex = (b58: string) => "0x" + Buffer.from(base58ToBytes(b58)).toString("hex");

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL);
  const poolAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../node_modules_cache/BurnMintTokenPool.abi"), "utf-8"));
  const pool = new ethers.Contract(EVM_POOL, poolAbi, provider);

  const tokenAbi = [
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function MINTER_ROLE() view returns (bytes32)",
    "function BURNER_ROLE() view returns (bytes32)",
    "function isMinter(address) view returns (bool)",
    "function isBurner(address) view returns (bool)",
    "function decimals() view returns (uint8)",
  ];
  const token = new ethers.Contract(RWA_TOKEN, tokenAbi, provider);
  const wl = new ethers.Contract(WHITELIST, ["function isWhitelisted(address) view returns (bool)"], provider);

  console.log("EVM pool:", EVM_POOL);
  console.log("Solana selector:", SOL_SELECTOR.toString());
  console.log("\n=== 1. Pool wiring ===");
  const poolToken = await pool.getToken();
  const poolRouter = await pool.getRouter();
  console.log("pool.getToken():   ", poolToken, poolToken.toLowerCase() === RWA_TOKEN.toLowerCase() ? "✅ = RWA token" : "❌ MISMATCH");
  console.log("pool.getRouter():  ", poolRouter, poolRouter.toLowerCase() === SEPOLIA_CCIP_ROUTER.toLowerCase() ? "✅ = Sepolia CCIP router" : "❌ NOT the CCIP router (inbound will revert onlyRouter)");

  console.log("\n=== 2. Remote (Solana) config ===");
  const supported = await pool.isSupportedChain(SOL_SELECTOR);
  console.log("isSupportedChain(solana):", supported, supported ? "✅" : "❌");
  let remotePool = "n/a", remoteToken = "n/a";
  try { remotePool = await pool.getRemotePool(SOL_SELECTOR); } catch (e:any) { remotePool = "ERR " + e.message; }
  try { remoteToken = await pool.getRemoteToken(SOL_SELECTOR); } catch (e:any) { remoteToken = "ERR " + e.message; }
  const expStatePda = toHex(A53U_STATE_PDA_B58).toLowerCase();
  const expSignerPda = toHex(A53U_SIGNER_PDA_B58).toLowerCase();
  const expMint = toHex(A53U_MINT_B58).toLowerCase();
  console.log("getRemotePool():   ", remotePool);
  console.log("  expected STATE PDA:", expStatePda, remotePool.toLowerCase() === expStatePda ? "✅ correct" : "");
  console.log("  (signer PDA):      ", expSignerPda, remotePool.toLowerCase() === expSignerPda ? "⚠️ set to SIGNER PDA — WRONG, causes InvalidSourcePoolAddress" : "");
  console.log("getRemoteToken():  ", remoteToken);
  console.log("  expected A53U mint:", expMint, remoteToken.toLowerCase() === expMint ? "✅ correct" : "❌ MISMATCH");

  console.log("\n=== 3. Pool mint/burn authority on RWA token ===");
  try {
    const mr = await token.MINTER_ROLE(); const br = await token.BURNER_ROLE();
    console.log("hasRole(MINTER, pool):", await token.hasRole(mr, EVM_POOL));
    console.log("hasRole(BURNER, pool):", await token.hasRole(br, EVM_POOL));
  } catch {
    try { console.log("isMinter(pool):", await token.isMinter(EVM_POOL), "| isBurner(pool):", await token.isBurner(EVM_POOL)); }
    catch (e:any) { console.log("role check failed:", e.message); }
  }

  console.log("\n=== 4. Whitelist (RWA token enforces it on mint/transfer) ===");
  console.log("isWhitelisted(pool):    ", await wl.isWhitelisted(EVM_POOL));
  console.log("isWhitelisted(receiver):", TEST_RECEIVER, await wl.isWhitelisted(TEST_RECEIVER), "  <- our test sends used this receiver");
}

main().catch((e) => { console.error("Error:", e.message || e); process.exit(1); });
