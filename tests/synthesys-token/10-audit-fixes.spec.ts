/**
 * synthesys-token — regression tests for the FailSafe audit findings.
 *
 * One (or more) `it` per finding, named `Finding N`. Bridge-window guards (Findings 1-3)
 * are exercised with Token-2022 as a stand-in "router": rejection paths revert inside
 * pre_bridge_send before that instruction ever executes, and the acceptance path proves
 * pre_bridge_send passes a valid layout (the tx then fails downstream at Token-2022, not
 * with a bridge error). The real end-to-end happy path runs on devnet via
 * scripts/svm/synthesys-token/8_bridge-send.ts against the live CCIP router.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  AccountMeta, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createAccount, getMintLen, getMint, ExtensionType,
  AccountState, createInitializeMintInstruction, createInitializePermanentDelegateInstruction,
  createInitializeDefaultAccountStateInstruction, createInitializeTransferHookInstruction,
  createInitializeMintCloseAuthorityInstruction, createInitializeTransferFeeConfigInstruction,
} from "@solana/spl-token";
import { createHash } from "crypto";
import { expect } from "chai";
import {
  Ctx, findPDA, getTokenAccount, createSynthesysMint, createATA, whitelistPda, blocklistPda, rolePda,
  TOKEN_CONFIG_SEED, AUTHORITY_SEED, ADMIN_ROLE, MINTER_ROLE, BURNER_ROLE, DEFAULT_ADMIN_ROLE,
} from "../synthesys-helpers";
import {
  getCtx, program, provider, connection, admin, programId, mallory,
  wlOpt, bl, addWhitelist, ensureFunded, expectRevert,
} from "./fixtures";

const CCIP_SEND_DISCRIMINATOR = Buffer.from([108, 216, 134, 191, 249, 234, 33, 84]);
const PROGRAM_CONFIG_SEED = Buffer.from("program_config");
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const BRIDGE_ERRORS = [
  "BridgeSourceAccountMismatch", "UnexpectedCcipSendAccountLayout",
  "MultipleSendsInBridgeWindow", "BridgeSendMissing", "BridgeCallerMustBeTopLevel",
];

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

/** Byte-faithful `ccip_send` instruction data (disc + dest_selector + SVM2AnyMessage + token_indexes). */
function ccipData({ nTokens = 1, tokenIndexes = [0] }: { nTokens?: number; tokenIndexes?: number[] } = {}) {
  return Buffer.concat([
    CCIP_SEND_DISCRIMINATOR,
    Buffer.alloc(8),                                              // dest_chain_selector: u64
    u32(0),                                                       // message.receiver: bytes (empty)
    u32(0),                                                       // message.data: bytes (empty)
    u32(nTokens), Buffer.alloc(40 * nTokens),                    // message.token_amounts: Vec<SVMTokenAmount>
    Buffer.alloc(32),                                            // message.fee_token: pubkey
    u32(0),                                                       // message.extra_args: bytes (empty)
    Buffer.concat([u32(tokenIndexes.length), Buffer.from(tokenIndexes)]), // token_indexes: bytes
  ]);
}

/** `ccip_send` account metas: `count` accounts, with `debited` at the user-token slot (index 18). */
function ccipKeys(debited: PublicKey, { count = 19, sourceIndex = 18, writable = true } = {}): AccountMeta[] {
  const filler = Keypair.generate().publicKey;
  return Array.from({ length: count }, (_, i) =>
    i === sourceIndex
      ? { pubkey: debited, isSigner: false, isWritable: writable }
      : { pubkey: filler, isSigner: false, isWritable: false });
}

describe("synthesys-token — audit fixes", () => {
  let ctx: Ctx;
  before(async () => { ctx = await getCtx(); });

  /** Thaw a token account (blocklist-only mint path — no whitelist needed). */
  async function thawOff(mint: PublicKey, tokenConfig: PublicKey, authorityPda: PublicKey, owner: PublicKey, tokenAccount: PublicKey) {
    await program.methods.thawTokenAccount().accounts({
      signer: admin.publicKey, tokenConfig, mint, tokenAccount,
      ownerWhitelist: null, ownerBlocklist: blocklistPda(mint, owner, programId),
      authorityPda, tokenProgram: TOKEN_2022_PROGRAM_ID,
    } as any).rpc();
  }

  // ===========================================================================
  // Findings 4 / 5 / 6 — freeze-scope gap: blocklist/de-whitelist must cover every
  // token account the owner holds for the mint, not just the one passed.
  // ===========================================================================
  describe("Findings 4/5/6 — sibling-account freeze scope", () => {
    it("Finding 4: add_blocklist freezes the owner's sibling token accounts (passed as remaining accounts)", async () => {
      const u = Keypair.generate();
      const mode = ctx.off;
      const ata = await createATA(provider, admin, u.publicKey, mode.mint.publicKey);
      const sibling = await createAccount(connection, admin, mode.mint.publicKey, u.publicKey, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);
      await thawOff(mode.mint.publicKey, mode.tokenConfig, mode.authorityPda, u.publicKey, ata);
      await thawOff(mode.mint.publicKey, mode.tokenConfig, mode.authorityPda, u.publicKey, sibling);
      expect((await getTokenAccount(connection, ata)).isFrozen).to.be.false;
      expect((await getTokenAccount(connection, sibling)).isFrozen).to.be.false;

      await program.methods.addBlocklist(u.publicKey).accounts({
        authority: admin.publicKey, payer: admin.publicKey, roleEntry: mode.adminRolePda,
        tokenConfig: mode.tokenConfig, mint: mode.mint.publicKey, blocklistEntry: bl(mode, u.publicKey),
        authorityPda: mode.authorityPda, targetTokenAccount: ata,
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      } as any).remainingAccounts([{ pubkey: sibling, isSigner: false, isWritable: true }]).rpc();

      expect((await getTokenAccount(connection, ata)).isFrozen, "target frozen").to.be.true;
      expect((await getTokenAccount(connection, sibling)).isFrozen, "sibling frozen").to.be.true;
    });

    it("Finding 4: add_blocklist rejects a remaining account owned by someone else (TokenAccountOwnerMismatch)", async () => {
      const u = Keypair.generate();
      const other = Keypair.generate();
      const mode = ctx.off;
      const ata = await createATA(provider, admin, u.publicKey, mode.mint.publicKey);
      const otherAta = await createATA(provider, admin, other.publicKey, mode.mint.publicKey);
      await expectRevert(
        program.methods.addBlocklist(u.publicKey).accounts({
          authority: admin.publicKey, payer: admin.publicKey, roleEntry: mode.adminRolePda,
          tokenConfig: mode.tokenConfig, mint: mode.mint.publicKey, blocklistEntry: bl(mode, u.publicKey),
          authorityPda: mode.authorityPda, targetTokenAccount: ata,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        } as any).remainingAccounts([{ pubkey: otherAta, isSigner: false, isWritable: true }]).rpc(),
        "TokenAccountOwnerMismatch",
      );
    });

    it("Findings 5 & 6: remove_whitelist freezes all of the owner's token accounts, so a thaw made while compliant does not survive de-whitelisting", async () => {
      const u = Keypair.generate();
      const mode = ctx.on;
      await addWhitelist(mode, u.publicKey);
      const ata = await createATA(provider, admin, u.publicKey, mode.mint.publicKey);
      const sibling = await createAccount(connection, admin, mode.mint.publicKey, u.publicKey, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);
      // Thaw both while the owner is still whitelisted (Finding 6's "brief compliance window").
      const wl = whitelistPda(mode.mint.publicKey, u.publicKey, programId);
      for (const acct of [ata, sibling]) {
        await program.methods.thawTokenAccount().accounts({
          signer: admin.publicKey, tokenConfig: mode.tokenConfig, mint: mode.mint.publicKey, tokenAccount: acct,
          ownerWhitelist: wl, ownerBlocklist: bl(mode, u.publicKey), authorityPda: mode.authorityPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        } as any).rpc();
      }
      expect((await getTokenAccount(connection, sibling)).isFrozen).to.be.false;

      await program.methods.removeWhitelist(u.publicKey).accounts({
        authority: admin.publicKey, payer: admin.publicKey, roleEntry: mode.adminRolePda,
        tokenConfig: mode.tokenConfig, mint: mode.mint.publicKey, whitelistEntry: wl,
        authorityPda: mode.authorityPda, targetTokenAccount: ata, tokenProgram: TOKEN_2022_PROGRAM_ID,
      } as any).remainingAccounts([{ pubkey: sibling, isSigner: false, isWritable: true }]).rpc();

      expect((await getTokenAccount(connection, ata)).isFrozen, "target frozen").to.be.true;
      expect((await getTokenAccount(connection, sibling)).isFrozen, "sibling frozen").to.be.true;
      expect(await connection.getAccountInfo(wl), "whitelist PDA closed").to.be.null;
    });
  });

  // ===========================================================================
  // Findings 7 / 13 — initialize() mint-extension validation.
  // ===========================================================================
  describe("Findings 7/13 — initialize() extension validation", () => {
    /** Build a Token-2022 mint pre-wired for this program, with optional deviations. */
    async function buildMint({ withTransferFee = false, hookAuthority }: { withTransferFee?: boolean; hookAuthority?: PublicKey } = {}) {
      const kp = Keypair.generate();
      const mint = kp.publicKey;
      const [authPda] = findPDA([AUTHORITY_SEED, mint.toBuffer()], programId);
      const exts = [ExtensionType.PermanentDelegate, ExtensionType.DefaultAccountState, ExtensionType.TransferHook, ExtensionType.MintCloseAuthority];
      if (withTransferFee) exts.push(ExtensionType.TransferFeeConfig);
      const lamports = await connection.getMinimumBalanceForRentExemption(getMintLen(exts));
      const tx = new Transaction();
      tx.add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint, space: getMintLen(exts), lamports, programId: TOKEN_2022_PROGRAM_ID }));
      if (withTransferFee) tx.add(createInitializeTransferFeeConfigInstruction(mint, admin.publicKey, admin.publicKey, 100, BigInt(1_000_000), TOKEN_2022_PROGRAM_ID));
      tx.add(createInitializeMintCloseAuthorityInstruction(mint, authPda, TOKEN_2022_PROGRAM_ID));
      tx.add(createInitializePermanentDelegateInstruction(mint, authPda, TOKEN_2022_PROGRAM_ID));
      tx.add(createInitializeDefaultAccountStateInstruction(mint, AccountState.Frozen, TOKEN_2022_PROGRAM_ID));
      tx.add(createInitializeTransferHookInstruction(mint, hookAuthority ?? authPda, programId, TOKEN_2022_PROGRAM_ID));
      tx.add(createInitializeMintInstruction(mint, 6, authPda, authPda, TOKEN_2022_PROGRAM_ID));
      await provider.sendAndConfirm(tx, [admin, kp]);
      return { mint, authPda };
    }

    function initializeIx(mint: PublicKey, authPda: PublicKey) {
      return program.methods.initialize(admin.publicKey, admin.publicKey, false).accounts({
        authority: admin.publicKey, payer: admin.publicKey, mint,
        tokenConfig: findPDA([TOKEN_CONFIG_SEED, mint.toBuffer()], programId)[0],
        adminRoleEntry: rolePda(mint, ADMIN_ROLE, admin.publicKey, programId),
        minterRoleEntry: rolePda(mint, MINTER_ROLE, admin.publicKey, programId),
        burnerRoleEntry: rolePda(mint, BURNER_ROLE, admin.publicKey, programId),
        defaultAdminRoleEntry: rolePda(mint, DEFAULT_ADMIN_ROLE, admin.publicKey, programId),
        authorityPda: authPda, programConfig: null, systemProgram: SystemProgram.programId,
      } as any).rpc();
    }

    it("Finding 7: initialize() rejects a mint carrying a disallowed extension (TransferFeeConfig)", async () => {
      const { mint, authPda } = await buildMint({ withTransferFee: true });
      await expectRevert(initializeIx(mint, authPda), "DisallowedMintExtension");
    });

    it("Finding 13: initialize() rejects a mint whose TransferHook.authority is not authority_pda", async () => {
      const { mint, authPda } = await buildMint({ hookAuthority: Keypair.generate().publicKey });
      await expectRevert(initializeIx(mint, authPda), "InvalidMintConfiguration");
    });

    it("control: a correctly-configured mint still initializes", async () => {
      const { mint, authPda } = await buildMint();
      await initializeIx(mint, authPda); // must not throw
      const cfg = await program.account.tokenConfig.fetch(findPDA([TOKEN_CONFIG_SEED, mint.toBuffer()], programId)[0]);
      expect(cfg.mint.toBase58()).to.equal(mint.toBase58());
    });
  });

  // ===========================================================================
  // Finding 9 — mint-authority handoff hardening.
  // ===========================================================================
  describe("Finding 9 — mint-authority handoff safeguards", () => {
    /**
     * Build + initialize a fresh compliant mint so the destructive two-step accept path
     * (which actually moves the mint authority off authority_pda) never touches a shared
     * mint. `admin` holds ADMIN_ROLE and authority_pda is the initial mint authority.
     */
    async function setupFreshMint() {
      const kp = Keypair.generate();
      const mint = kp.publicKey;
      const [authPda] = findPDA([AUTHORITY_SEED, mint.toBuffer()], programId);
      const exts = [ExtensionType.PermanentDelegate, ExtensionType.DefaultAccountState, ExtensionType.TransferHook];
      const lamports = await connection.getMinimumBalanceForRentExemption(getMintLen(exts));
      const tx = new Transaction();
      tx.add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint, space: getMintLen(exts), lamports, programId: TOKEN_2022_PROGRAM_ID }));
      tx.add(createInitializePermanentDelegateInstruction(mint, authPda, TOKEN_2022_PROGRAM_ID));
      tx.add(createInitializeDefaultAccountStateInstruction(mint, AccountState.Frozen, TOKEN_2022_PROGRAM_ID));
      tx.add(createInitializeTransferHookInstruction(mint, authPda, programId, TOKEN_2022_PROGRAM_ID));
      tx.add(createInitializeMintInstruction(mint, 6, authPda, authPda, TOKEN_2022_PROGRAM_ID));
      await provider.sendAndConfirm(tx, [admin, kp]);
      const tokenConfig = findPDA([TOKEN_CONFIG_SEED, mint.toBuffer()], programId)[0];
      await program.methods.initialize(admin.publicKey, admin.publicKey, false).accounts({
        authority: admin.publicKey, payer: admin.publicKey, mint, tokenConfig,
        adminRoleEntry: rolePda(mint, ADMIN_ROLE, admin.publicKey, programId),
        minterRoleEntry: rolePda(mint, MINTER_ROLE, admin.publicKey, programId),
        burnerRoleEntry: rolePda(mint, BURNER_ROLE, admin.publicKey, programId),
        defaultAdminRoleEntry: rolePda(mint, DEFAULT_ADMIN_ROLE, admin.publicKey, programId),
        authorityPda: authPda, programConfig: null, systemProgram: SystemProgram.programId,
      } as any).rpc();
      return { mint, authPda, tokenConfig, adminRolePda: rolePda(mint, ADMIN_ROLE, admin.publicKey, programId) };
    }

    it("Finding 9: one-step transfer rejects a zero-address destination (InvalidZeroAddress)", async () => {
      await expectRevert(
        program.methods.transferMintAuthority(PublicKey.default).accounts({
          signer: admin.publicKey, roleEntry: ctx.off.adminRolePda, tokenConfig: ctx.off.tokenConfig,
          authorityPda: ctx.off.authorityPda, mint: ctx.off.mint.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID,
        } as any).rpc(),
        "InvalidZeroAddress",
      );
    });

    it("Finding 9: one-step transfer emits MintAuthorityTransferred with the old and new authority", async () => {
      const newAuthority = Keypair.generate().publicKey;
      const sim = await program.methods.transferMintAuthority(newAuthority).accounts({
        signer: admin.publicKey, roleEntry: ctx.off.adminRolePda, tokenConfig: ctx.off.tokenConfig,
        authorityPda: ctx.off.authorityPda, mint: ctx.off.mint.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID,
      } as any).simulate();
      const ev = sim.events.find((e) => e.name.toLowerCase() === "mintauthoritytransferred");
      expect(ev, "MintAuthorityTransferred emitted").to.not.be.undefined;
      expect(ev!.data.previousAuthority.toBase58()).to.equal(ctx.off.authorityPda.toBase58());
      expect(ev!.data.newAuthority.toBase58()).to.equal(newAuthority.toBase58());
    });

    it("Finding 9: two-step propose records the pending candidate and emits MintAuthorityProposed", async () => {
      const { mint, tokenConfig, adminRolePda } = await setupFreshMint();
      const candidate = Keypair.generate().publicKey;
      const sim = await program.methods.proposeMintAuthority(candidate)
        .accounts({ signer: admin.publicKey, roleEntry: adminRolePda, tokenConfig, mint } as any)
        .simulate();
      const ev = sim.events.find((e) => e.name.toLowerCase() === "mintauthorityproposed");
      expect(ev, "MintAuthorityProposed emitted").to.not.be.undefined;
      expect(ev!.data.candidate.toBase58()).to.equal(candidate.toBase58());

      await program.methods.proposeMintAuthority(candidate)
        .accounts({ signer: admin.publicKey, roleEntry: adminRolePda, tokenConfig, mint } as any)
        .rpc();
      const cfg = await program.account.tokenConfig.fetch(tokenConfig);
      expect(cfg.pendingMintAuthority?.toBase58()).to.equal(candidate.toBase58());
    });

    it("Finding 9: two-step accept rejects a signer that is not the pending candidate (NotPendingMintAuthority)", async () => {
      const { mint, authPda, tokenConfig, adminRolePda } = await setupFreshMint();
      const candidate = Keypair.generate().publicKey;
      await program.methods.proposeMintAuthority(candidate)
        .accounts({ signer: admin.publicKey, roleEntry: adminRolePda, tokenConfig, mint } as any)
        .rpc();

      const impostor = Keypair.generate();
      await expectRevert(
        program.methods.acceptMintAuthority()
          .accounts({ candidate: impostor.publicKey, tokenConfig, authorityPda: authPda, mint, tokenProgram: TOKEN_2022_PROGRAM_ID } as any)
          .signers([impostor]).rpc(),
        "NotPendingMintAuthority",
      );
    });

    it("Finding 9: two-step accept moves the authority only when the candidate signs, then clears pending", async () => {
      const { mint, authPda, tokenConfig, adminRolePda } = await setupFreshMint();
      const candidate = Keypair.generate();
      await program.methods.proposeMintAuthority(candidate.publicKey)
        .accounts({ signer: admin.publicKey, roleEntry: adminRolePda, tokenConfig, mint } as any)
        .rpc();

      // Authority has NOT moved yet — authority_pda still holds MintTokens.
      let mintAcc = await getMint(connection, mint, undefined, TOKEN_2022_PROGRAM_ID);
      expect(mintAcc.mintAuthority?.toBase58()).to.equal(authPda.toBase58());

      await program.methods.acceptMintAuthority()
        .accounts({ candidate: candidate.publicKey, tokenConfig, authorityPda: authPda, mint, tokenProgram: TOKEN_2022_PROGRAM_ID } as any)
        .signers([candidate]).rpc();

      mintAcc = await getMint(connection, mint, undefined, TOKEN_2022_PROGRAM_ID);
      expect(mintAcc.mintAuthority?.toBase58(), "authority moved to candidate").to.equal(candidate.publicKey.toBase58());
      const cfg = await program.account.tokenConfig.fetch(tokenConfig);
      expect(cfg.pendingMintAuthority, "pending cleared after accept").to.be.null;
    });
  });

  // ===========================================================================
  // Finding 12 — burn/force events carry the token-account address.
  // ===========================================================================
  it("Finding 12: TokenBurned carries from_token_account, not just the owner", async () => {
    // admin holds BURNER_ROLE on both mints (granted at initialize).
    const ata = await ensureFunded(ctx.off, admin, 50_000);
    const sim = await program.methods.burnSelf(new anchor.BN(1_000)).accounts({
      signer: admin.publicKey, roleEntry: rolePda(ctx.off.mint.publicKey, BURNER_ROLE, admin.publicKey, programId),
      tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey, signerTokenAccount: ata,
      signerWhitelist: wlOpt(ctx.off, admin.publicKey), signerOwnerBlocklist: bl(ctx.off, admin.publicKey),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    } as any).simulate();
    const ev = sim.events.find((e) => e.name.toLowerCase() === "tokenburned");
    expect(ev, "TokenBurned emitted").to.not.be.undefined;
    expect(ev!.data.from.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(ev!.data.fromTokenAccount.toBase58()).to.equal(ata.toBase58());
  });

  // ===========================================================================
  // Finding 11 — transfer-hook handler rejects a direct (non-transfer) call.
  // ===========================================================================
  it("Finding 11: a direct call to the transfer-hook handler reverts (HookNotInTransfer)", async () => {
    const mode = ctx.off;
    const owner = Keypair.generate();
    const source = await createATA(provider, admin, owner.publicKey, mode.mint.publicKey);
    const dummy = Keypair.generate().publicKey;

    const executeDisc = createHash("sha256").update("spl-transfer-hook-interface:execute").digest().subarray(0, 8);
    const data = Buffer.concat([executeDisc, Buffer.alloc(8)]); // Execute { amount: 0 }
    const keys: AccountMeta[] = [
      { pubkey: source, isSigner: false, isWritable: false },              // [0] source_token_account
      { pubkey: mode.mint.publicKey, isSigner: false, isWritable: false }, // [1] mint
      { pubkey: dummy, isSigner: false, isWritable: false },               // [2] destination
      { pubkey: dummy, isSigner: false, isWritable: false },               // [3] authority
      { pubkey: mode.extraAccountMetaList, isSigner: false, isWritable: false }, // [4] validation acct
      { pubkey: mode.tokenConfig, isSigner: false, isWritable: false },    // [5] token_config
      { pubkey: dummy, isSigner: false, isWritable: false },               // [6] from_whitelist
      { pubkey: dummy, isSigner: false, isWritable: false },               // [7] from_blocklist
      { pubkey: dummy, isSigner: false, isWritable: false },               // [8] to_whitelist
      { pubkey: dummy, isSigner: false, isWritable: false },               // [9] to_blocklist
      { pubkey: dummy, isSigner: false, isWritable: false },               // [10] authority_whitelist
      { pubkey: dummy, isSigner: false, isWritable: false },               // [11] authority_blocklist
    ];
    const ix = new TransactionInstruction({ programId, keys, data });
    await expectRevert(provider.sendAndConfirm(new Transaction().add(ix), []), "HookNotInTransfer");
  });

  // ===========================================================================
  // Finding 10 — bootstrapped initializer authority survives upgrade-authority revoke.
  // ===========================================================================
  describe("Finding 10 — bootstrapped initializer authority", () => {
    const [programConfigPda] = PublicKey.findProgramAddressSync([PROGRAM_CONFIG_SEED], programId);
    const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE);
    const initializer = Keypair.generate();

    it("Finding 10: set_initializer_authority is gated to the upgrade authority", async () => {
      await expectRevert(
        program.methods.setInitializerAuthority(mallory.publicKey).accounts({
          authority: mallory.publicKey, payer: mallory.publicKey, programConfig: programConfigPda,
          programData, systemProgram: SystemProgram.programId,
        } as any).signers([mallory]).rpc(),
        "Unauthorized",
      );
    });

    it("Finding 10: upgrade authority seats an initializer, who can then onboard a mint without being the upgrade authority", async () => {
      await program.methods.setInitializerAuthority(initializer.publicKey).accounts({
        authority: admin.publicKey, payer: admin.publicKey, programConfig: programConfigPda,
        programData, systemProgram: SystemProgram.programId,
      } as any).rpc();
      const cfg = await program.account.programConfig.fetch(programConfigPda);
      expect(cfg.initializerAuthority.toBase58()).to.equal(initializer.publicKey.toBase58());

      // The bootstrapped initializer (not the upgrade authority) can initialize a new mint.
      const mint = (await createSynthesysMint(provider, admin, programId)).publicKey;
      await program.methods.initialize(admin.publicKey, admin.publicKey, false).accounts({
        authority: initializer.publicKey, payer: admin.publicKey, mint,
        tokenConfig: findPDA([TOKEN_CONFIG_SEED, mint.toBuffer()], programId)[0],
        adminRoleEntry: rolePda(mint, ADMIN_ROLE, admin.publicKey, programId),
        minterRoleEntry: rolePda(mint, MINTER_ROLE, admin.publicKey, programId),
        burnerRoleEntry: rolePda(mint, BURNER_ROLE, admin.publicKey, programId),
        defaultAdminRoleEntry: rolePda(mint, DEFAULT_ADMIN_ROLE, admin.publicKey, programId),
        authorityPda: findPDA([AUTHORITY_SEED, mint.toBuffer()], programId)[0],
        programConfig: programConfigPda, systemProgram: SystemProgram.programId,
      } as any).signers([initializer]).rpc();
      const cfg2 = await program.account.tokenConfig.fetch(findPDA([TOKEN_CONFIG_SEED, mint.toBuffer()], programId)[0]);
      expect(cfg2.mint.toBase58()).to.equal(mint.toBase58());
    });
  });

  // ===========================================================================
  // Findings 1 / 2 / 3 — CCIP bridge-window guard.
  // ===========================================================================
  describe("Findings 1/2/3 — bridge-window guard", () => {
    // Fresh blocklist-only mint whose configured "router" is Token-2022 (a loadable
    // program). Rejection paths revert inside pre_bridge_send before it executes.
    let mint: PublicKey, tokenConfig: PublicKey, authorityPda: PublicKey, adminRolePda: PublicKey;
    let bridgeUser: Keypair, source: PublicKey;

    before(async () => {
      const kp = await createSynthesysMint(provider, admin, programId);
      mint = kp.publicKey;
      [tokenConfig] = findPDA([TOKEN_CONFIG_SEED, mint.toBuffer()], programId);
      [authorityPda] = findPDA([AUTHORITY_SEED, mint.toBuffer()], programId);
      adminRolePda = rolePda(mint, ADMIN_ROLE, admin.publicKey, programId);
      await program.methods.initialize(admin.publicKey, admin.publicKey, false).accounts({
        authority: admin.publicKey, payer: admin.publicKey, mint, tokenConfig,
        adminRoleEntry: adminRolePda,
        minterRoleEntry: rolePda(mint, MINTER_ROLE, admin.publicKey, programId),
        burnerRoleEntry: rolePda(mint, BURNER_ROLE, admin.publicKey, programId),
        defaultAdminRoleEntry: rolePda(mint, DEFAULT_ADMIN_ROLE, admin.publicKey, programId),
        authorityPda, programConfig: null, systemProgram: SystemProgram.programId,
      } as any).rpc();
      await program.methods.setCcipRouter(TOKEN_2022_PROGRAM_ID).accounts({
        signer: admin.publicKey, roleEntry: adminRolePda, tokenConfig, mint,
      } as any).rpc();
      bridgeUser = Keypair.generate();
      source = await createATA(provider, admin, bridgeUser.publicKey, mint);
    });

    const preIx = () => program.methods.preBridgeSend().accounts({
      signer: bridgeUser.publicKey, tokenConfig, mint, signerWhitelist: null,
      signerBlocklist: blocklistPda(mint, bridgeUser.publicKey, programId), authorityPda,
      sourceTokenAccount: source, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_2022_PROGRAM_ID,
    } as any).instruction();
    const postIx = () => program.methods.postBridgeRestore().accounts({
      mint, tokenConfig, authorityPda, tokenProgram: TOKEN_2022_PROGRAM_ID,
    } as any).instruction();
    const ccipIx = (keys: AccountMeta[], data = ccipData()) =>
      new TransactionInstruction({ programId: TOKEN_2022_PROGRAM_ID, keys, data });
    const sendBridge = async (mid: TransactionInstruction[]) =>
      provider.sendAndConfirm(new Transaction().add(await preIx(), ...mid, await postIx()), [admin, bridgeUser]);

    it("Finding 1: rejects a ccip_send that debits an account other than the declared source (BridgeSourceAccountMismatch)", async () => {
      const otherAccount = await createATA(provider, admin, Keypair.generate().publicKey, mint);
      await expectRevert(sendBridge([ccipIx(ccipKeys(otherAccount))]), "BridgeSourceAccountMismatch");
    });

    it("Finding 1: rejects a ccip_send whose declared source slot is read-only (BridgeSourceAccountMismatch)", async () => {
      await expectRevert(sendBridge([ccipIx(ccipKeys(source, { writable: false }))]), "BridgeSourceAccountMismatch");
    });

    it("Finding 2: rejects more than one ccip_send in the window (MultipleSendsInBridgeWindow)", async () => {
      await expectRevert(sendBridge([ccipIx(ccipKeys(source)), ccipIx(ccipKeys(source))]), "MultipleSendsInBridgeWindow");
    });

    it("Finding 2: rejects a window with no ccip_send (BridgeSendMissing)", async () => {
      await expectRevert(sendBridge([]), "BridgeSendMissing");
    });

    it("Finding 3: rejects a router instruction that shares the 8-byte prefix but has too few accounts (UnexpectedCcipSendAccountLayout)", async () => {
      await expectRevert(sendBridge([ccipIx(ccipKeys(source, { count: 10 }))]), "UnexpectedCcipSendAccountLayout");
    });

    it("Finding 3: rejects a router instruction whose payload is not a single-token send (UnexpectedCcipSendAccountLayout)", async () => {
      const multi = ccipData({ nTokens: 2, tokenIndexes: [0, 1] });
      await expectRevert(sendBridge([ccipIx(ccipKeys(source), multi)]), "UnexpectedCcipSendAccountLayout");
    });

    it("acceptance: pre_bridge_send passes a valid single-token layout (tx then fails downstream at the stub router, not with a bridge error)", async () => {
      let msg = "";
      try {
        await sendBridge([ccipIx(ccipKeys(source))]);
        expect.fail("expected the downstream Token-2022 execution to fail");
      } catch (e: any) {
        msg = (e.message ?? "") + JSON.stringify(e.logs ?? []);
      }
      for (const err of BRIDGE_ERRORS) expect(msg, `should not be rejected by the bridge guard (${err})`).to.not.include(err);
    });
  });
});
