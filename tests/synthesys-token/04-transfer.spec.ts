/**
 * synthesys-token — transfer_checked through the Token-2022 transfer hook.
 */
import { Transaction } from "@solana/web3.js";
import { createApproveCheckedInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { Ctx, getTokenAccount, createATA, buildTransferWithHookIx } from "../synthesys-helpers";
import { getCtx, program, provider, connection, admin, alice, bob, carol, outsider, delegate, ensureFunded, addBlocklist, removeBlocklist, expectRevert } from "./fixtures";

describe("synthesys-token", () => {
  let ctx: Ctx;
  before(async () => { ctx = await getCtx(); });

  // ===========================================================================
  // F. transfer_checked (Token-2022 transfer hook)
  // ===========================================================================
  describe("transfer_checked (hook)", () => {
    it("[enabled] allows transfer between two whitelisted, thawed accounts", async () => {
      const src = await ensureFunded(ctx.on, alice, 500_000);
      const dst = await ensureFunded(ctx.on, bob, 1); // thaw bob's account
      const before = Number((await getTokenAccount(connection, dst)).amount);

      const ix = await buildTransferWithHookIx(connection, src, ctx.on.mint.publicKey, dst, alice.publicKey, BigInt(100_000), 6);
      await provider.sendAndConfirm(new Transaction().add(ix), [admin, alice]);

      const after = Number((await getTokenAccount(connection, dst)).amount);
      expect(after - before).to.equal(100_000);
    });

    it("[enabled] blocks transfer while paused (AllTransfersPaused)", async () => {
      const src = await ensureFunded(ctx.on, alice, 10_000);
      const dst = await ensureFunded(ctx.on, bob, 1);
      await program.methods.pause().accounts({ signer: admin.publicKey, roleEntry: ctx.on.adminRolePda, tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey } as any).rpc();
      try {
        const ix = await buildTransferWithHookIx(connection, src, ctx.on.mint.publicKey, dst, alice.publicKey, BigInt(1_000), 6);
        await expectRevert(
          provider.sendAndConfirm(new Transaction().add(ix), [admin, alice]),
          /AllTransfersPaused|0x1770/i,
        );
      } finally {
        await program.methods.unpause().accounts({ signer: admin.publicKey, roleEntry: ctx.on.adminRolePda, tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey } as any).rpc();
      }
    });

    it("[enabled] blocks transfer via a non-whitelisted delegate (authority branch)", async () => {
      const src = await ensureFunded(ctx.on, alice, 100_000);
      const dst = await ensureFunded(ctx.on, bob, 1);
      // alice approves a NON-whitelisted delegate directly via Token-2022.
      const approveIx = createApproveCheckedInstruction(src, ctx.on.mint.publicKey, outsider.publicKey, alice.publicKey, BigInt(50_000), 6, [], TOKEN_2022_PROGRAM_ID);
      await provider.sendAndConfirm(new Transaction().add(approveIx), [admin, alice]);

      const ix = await buildTransferWithHookIx(connection, src, ctx.on.mint.publicKey, dst, outsider.publicKey, BigInt(1_000), 6);
      await expectRevert(
        provider.sendAndConfirm(new Transaction().add(ix), [admin, outsider]),
        /SenderAddressNotWhitelisted|0x1772/i,
      );
    });

    it("[disabled] allows transfer between non-whitelisted (only non-blocklisted) accounts", async () => {
      const src = await ensureFunded(ctx.off, outsider, 500_000);
      const dst = await ensureFunded(ctx.off, carol, 1);
      const before = Number((await getTokenAccount(connection, dst)).amount);

      const ix = await buildTransferWithHookIx(connection, src, ctx.off.mint.publicKey, dst, outsider.publicKey, BigInt(100_000), 6);
      await provider.sendAndConfirm(new Transaction().add(ix), [admin, outsider]);

      const after = Number((await getTokenAccount(connection, dst)).amount);
      expect(after - before).to.equal(100_000);
    });

    it("[disabled] blocks transfer via a blocklisted delegate (authority branch → SenderAddressBlocked)", async () => {
      const src = await ensureFunded(ctx.off, outsider, 100_000);
      const dst = await ensureFunded(ctx.off, carol, 1);
      // outsider approves `delegate`, then admin blocklists `delegate`.
      const approveIx = createApproveCheckedInstruction(src, ctx.off.mint.publicKey, delegate.publicKey, outsider.publicKey, BigInt(50_000), 6, [], TOKEN_2022_PROGRAM_ID);
      await provider.sendAndConfirm(new Transaction().add(approveIx), [admin, outsider]);
      const dlgAta = await createATA(provider, admin, delegate.publicKey, ctx.off.mint.publicKey);
      await addBlocklist(ctx.off, delegate.publicKey, dlgAta);

      const ix = await buildTransferWithHookIx(connection, src, ctx.off.mint.publicKey, dst, delegate.publicKey, BigInt(1_000), 6);
      await expectRevert(
        provider.sendAndConfirm(new Transaction().add(ix), [admin, delegate]),
        /SenderAddressBlocked|0x1771/i,
      );
      await removeBlocklist(ctx.off, delegate.publicKey);
    });
  });
});
