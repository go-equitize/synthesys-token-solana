/**
 * synthesys-token — bridge (pre_bridge_send / post_bridge_restore) compliance gate.
 */
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Ctx, Mode, createATA, buildTransferWithHookIx, whitelistPda } from "../synthesys-helpers";
import { getCtx, program, provider, admin, alice, outsider, blocked, bl, ensureFunded, addWhitelist, addBlocklist, removeBlocklist, expectRevert } from "./fixtures";

describe("synthesys-token", () => {
  let ctx: Ctx;
  before(async () => { ctx = await getCtx(); });

  // ===========================================================================
  // M. bridge (pre_bridge_send / post_bridge_restore) compliance gate
  // ===========================================================================
  describe("bridge window compliance", () => {
    const router = Keypair.generate().publicKey; // stand-in router program id (never CPI'd here)

    async function setRouter(mode: Mode) {
      await program.methods.setCcipRouter(router).accounts({ signer: admin.publicKey, roleEntry: mode.adminRolePda, tokenConfig: mode.tokenConfig, mint: mode.mint.publicKey } as any).rpc();
    }

    function preAccounts(mode: Mode, signer: PublicKey, sourceAta: PublicKey, wl: PublicKey | null) {
      return {
        signer,
        tokenConfig: mode.tokenConfig,
        mint: mode.mint.publicKey,
        signerWhitelist: wl,
        signerBlocklist: bl(mode, signer),
        authorityPda: mode.authorityPda,
        sourceTokenAccount: sourceAta,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      };
    }
    function postAccounts(mode: Mode) {
      return { mint: mode.mint.publicKey, tokenConfig: mode.tokenConfig, authorityPda: mode.authorityPda, tokenProgram: TOKEN_2022_PROGRAM_ID };
    }

    it("[disabled] rejects pre_bridge_send before a router is configured (CcipRouterNotConfigured)", async () => {
      const ata = await createATA(provider, admin, outsider.publicKey, ctx.off.mint.publicKey);
      await expectRevert(
        program.methods.preBridgeSend().accounts(preAccounts(ctx.off, outsider.publicKey, ata, null) as any).signers([outsider]).rpc(),
        "CcipRouterNotConfigured",
      );
    });

    it("[disabled] rejects a bridge window with no ccip_send (BridgeSendMissing)", async () => {
      await setRouter(ctx.off);
      // Fresh actors so this test owns its state (earlier tests leave some ATAs frozen).
      const bridgeUser = Keypair.generate();
      const dstUser = Keypair.generate();
      const ata = await createATA(provider, admin, bridgeUser.publicKey, ctx.off.mint.publicKey);

      // A window that opens the hook-off gap but performs no bridging is now rejected —
      // the hook is never toggled because the whole tx reverts atomically.
      const preIx = await program.methods.preBridgeSend().accounts(preAccounts(ctx.off, bridgeUser.publicKey, ata, null) as any).instruction();
      const postIx = await program.methods.postBridgeRestore().accounts(postAccounts(ctx.off) as any).instruction();
      await expectRevert(
        provider.sendAndConfirm(new Transaction().add(preIx).add(postIx), [admin, bridgeUser]),
        "BridgeSendMissing",
      );

      // The hook still enforces on a normal (non-bridge) transfer.
      const src = await ensureFunded(ctx.off, bridgeUser, 10_000); // fresh → minted → thawed
      const dst = await ensureFunded(ctx.off, dstUser, 1);
      const ix = await buildTransferWithHookIx(provider.connection, src, ctx.off.mint.publicKey, dst, bridgeUser.publicKey, BigInt(1_000), 6);
      await provider.sendAndConfirm(new Transaction().add(ix), [admin, bridgeUser]);
    });

    it("[disabled] rejects a blocklisted signer (SenderAddressBlocked)", async () => {
      const ata = await createATA(provider, admin, blocked.publicKey, ctx.off.mint.publicKey);
      await addBlocklist(ctx.off, blocked.publicKey, ata);
      const preIx = program.methods.preBridgeSend().accounts(preAccounts(ctx.off, blocked.publicKey, ata, null) as any).instruction();
      await expectRevert(
        (async () => { const ix = await preIx; return provider.sendAndConfirm(new Transaction().add(ix), [admin, blocked]); })(),
        /SenderAddressBlocked|0x1771/i,
      );
      await removeBlocklist(ctx.off, blocked.publicKey);
    });

    it("[enabled] rejects a non-whitelisted signer (SenderAddressNotWhitelisted)", async () => {
      await setRouter(ctx.on);
      const ata = await createATA(provider, admin, outsider.publicKey, ctx.on.mint.publicKey);
      const preIx = await program.methods.preBridgeSend().accounts(preAccounts(ctx.on, outsider.publicKey, ata, whitelistPda(ctx.on.mint.publicKey, outsider.publicKey, program.programId)) as any).instruction();
      await expectRevert(
        provider.sendAndConfirm(new Transaction().add(preIx), [admin, outsider]),
        /SenderAddressNotWhitelisted|0x1772/i,
      );
    });

    it("[enabled] rejects when the signer whitelist PDA is OMITTED (WhitelistAccountMissing)", async () => {
      const ata = await createATA(provider, admin, alice.publicKey, ctx.on.mint.publicKey);
      const preIx = await program.methods.preBridgeSend().accounts(preAccounts(ctx.on, alice.publicKey, ata, null) as any).instruction();
      await expectRevert(
        provider.sendAndConfirm(new Transaction().add(preIx), [admin, alice]),
        "WhitelistAccountMissing",
      );
    });

    it("[enabled] rejects pre_bridge_send with no paired post_bridge_restore (MissingPostBridgeRestore)", async () => {
      const ata = getAssociatedTokenAddressSync(ctx.on.mint.publicKey, alice.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await createATA(provider, admin, alice.publicKey, ctx.on.mint.publicKey);
      const preIx = await program.methods.preBridgeSend().accounts(preAccounts(ctx.on, alice.publicKey, ata, whitelistPda(ctx.on.mint.publicKey, alice.publicKey, program.programId)) as any).instruction();
      await expectRevert(
        provider.sendAndConfirm(new Transaction().add(preIx), [admin, alice]),
        "MissingPostBridgeRestore",
      );
    });

    it("[enabled] rejects a bridge window with no ccip_send even for a whitelisted signer (BridgeSendMissing)", async () => {
      const ata = await createATA(provider, admin, alice.publicKey, ctx.on.mint.publicKey);
      const preIx = await program.methods.preBridgeSend().accounts(preAccounts(ctx.on, alice.publicKey, ata, whitelistPda(ctx.on.mint.publicKey, alice.publicKey, program.programId)) as any).instruction();
      const postIx = await program.methods.postBridgeRestore().accounts(postAccounts(ctx.on) as any).instruction();
      await expectRevert(
        provider.sendAndConfirm(new Transaction().add(preIx).add(postIx), [admin, alice]),
        "BridgeSendMissing",
      );
    });

    // -------------------------------------------------------------------------
    // INV-BRIDGE-001 sandwich guard: only ComputeBudget instructions and the configured
    // router's ccip_send may appear between pre_bridge_send and post_bridge_restore. This
    // is what stops an unrelated transfer/mint from riding the hook-off window. Previously
    // unexercised by any test — the code path was correct but unverified end-to-end.
    // -------------------------------------------------------------------------
    it("[enabled] rejects a transfer sandwiched between pre_bridge_send and post_bridge_restore (DisallowedInstructionInBridgeWindow)", async () => {
      const bridgeUser = Keypair.generate();
      const dstUser = Keypair.generate();
      await addWhitelist(ctx.on, bridgeUser.publicKey);
      await addWhitelist(ctx.on, dstUser.publicKey);
      const src = await ensureFunded(ctx.on, bridgeUser, 10_000);
      const dst = await ensureFunded(ctx.on, dstUser, 1);

      const preIx = await program.methods
        .preBridgeSend()
        .accounts(preAccounts(ctx.on, bridgeUser.publicKey, src, whitelistPda(ctx.on.mint.publicKey, bridgeUser.publicKey, program.programId)) as any)
        .instruction();
      // Sandwiched instruction: an ordinary hook-mediated transfer — disallowed while the
      // window is open, even though the hook itself is disabled and would otherwise let it
      // through unchecked.
      const xferIx = await buildTransferWithHookIx(provider.connection, src, ctx.on.mint.publicKey, dst, bridgeUser.publicKey, BigInt(100), 6);
      const postIx = await program.methods.postBridgeRestore().accounts(postAccounts(ctx.on) as any).instruction();

      await expectRevert(
        provider.sendAndConfirm(new Transaction().add(preIx).add(xferIx).add(postIx), [admin, bridgeUser]),
        "DisallowedInstructionInBridgeWindow",
      );
    });

    it("[enabled] rejects a second pre_bridge_send stacked in the same window (DisallowedInstructionInBridgeWindow)", async () => {
      const bridgeUser = Keypair.generate();
      await addWhitelist(ctx.on, bridgeUser.publicKey);
      const src = await ensureFunded(ctx.on, bridgeUser, 10_000);

      const preAccs = preAccounts(ctx.on, bridgeUser.publicKey, src, whitelistPda(ctx.on.mint.publicKey, bridgeUser.publicKey, program.programId)) as any;
      const preIx1 = await program.methods.preBridgeSend().accounts(preAccs).instruction();
      const preIx2 = await program.methods.preBridgeSend().accounts(preAccs).instruction();
      const postIx = await program.methods.postBridgeRestore().accounts(postAccounts(ctx.on) as any).instruction();

      await expectRevert(
        provider.sendAndConfirm(new Transaction().add(preIx1).add(preIx2).add(postIx), [admin, bridgeUser]),
        "DisallowedInstructionInBridgeWindow",
      );
    });
  });
});
