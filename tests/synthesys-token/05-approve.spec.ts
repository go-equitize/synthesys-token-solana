/**
 * synthesys-token — approve_tokens (compliance-gated approve).
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { expect } from "chai";
import { Ctx, Mode, getTokenAccount, createATA, whitelistPda } from "../synthesys-helpers";
import { getCtx, program, provider, admin, connection, alice, outsider, carol, delegate, wlOpt, bl, ensureFunded, addBlocklist, removeBlocklist, expectRevert } from "./fixtures";

describe("synthesys-token", () => {
  let ctx: Ctx;
  before(async () => { ctx = await getCtx(); });

  // ===========================================================================
  // G. approve_tokens (compliance-gated approve)
  // ===========================================================================
  describe("approve_tokens", () => {
    function approveAccounts(mode: Mode, ownerKp: Keypair, delegatePk: PublicKey, ownerWl: PublicKey | null, delWl: PublicKey | null) {
      const ownerAta = getAssociatedTokenAddressSync(mode.mint.publicKey, ownerKp.publicKey, false, TOKEN_2022_PROGRAM_ID);
      return {
        signer: ownerKp.publicKey,
        tokenConfig: mode.tokenConfig,
        mint: mode.mint.publicKey,
        ownerTokenAccount: ownerAta,
        ownerWhitelist: ownerWl,
        ownerBlocklist: bl(mode, ownerKp.publicKey),
        delegateWhitelist: delWl,
        delegateBlocklist: bl(mode, delegatePk),
        delegate: delegatePk,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      };
    }

    it("[enabled] approves when owner & delegate are whitelisted", async () => {
      await ensureFunded(ctx.on, alice, 10_000);
      await program.methods
        .approveTokens(new anchor.BN(10_000))
        .accounts(approveAccounts(ctx.on, alice, delegate.publicKey, wlOpt(ctx.on, alice.publicKey), wlOpt(ctx.on, delegate.publicKey)) as any)
        .signers([alice])
        .rpc();
      const acct = await getTokenAccount(connection, getAssociatedTokenAddressSync(ctx.on.mint.publicKey, alice.publicKey, false, TOKEN_2022_PROGRAM_ID));
      expect(acct.delegate?.toBase58()).to.equal(delegate.publicKey.toBase58());
    });

    it("[enabled] rejects approve to a non-whitelisted delegate (ToAddressNotWhitelisted)", async () => {
      await ensureFunded(ctx.on, alice, 10_000);
      await expectRevert(
        program.methods
          .approveTokens(new anchor.BN(1_000))
          .accounts(approveAccounts(ctx.on, alice, outsider.publicKey, wlOpt(ctx.on, alice.publicKey), whitelistPda(ctx.on.mint.publicKey, outsider.publicKey, program.programId)) as any)
          .signers([alice])
          .rpc(),
        "ToAddressNotWhitelisted",
      );
    });

    it("[enabled] rejects approve when the delegate whitelist PDA is OMITTED (WhitelistAccountMissing)", async () => {
      await ensureFunded(ctx.on, alice, 10_000);
      await expectRevert(
        program.methods
          .approveTokens(new anchor.BN(1_000))
          .accounts(approveAccounts(ctx.on, alice, delegate.publicKey, wlOpt(ctx.on, alice.publicKey), null) as any)
          .signers([alice])
          .rpc(),
        "WhitelistAccountMissing",
      );
    });

    it("[disabled] approves with null whitelist PDAs", async () => {
      await ensureFunded(ctx.off, outsider, 10_000);
      await program.methods
        .approveTokens(new anchor.BN(5_000))
        .accounts(approveAccounts(ctx.off, outsider, carol.publicKey, null, null) as any)
        .signers([outsider])
        .rpc();
      const acct = await getTokenAccount(connection, getAssociatedTokenAddressSync(ctx.off.mint.publicKey, outsider.publicKey, false, TOKEN_2022_PROGRAM_ID));
      expect(acct.delegate?.toBase58()).to.equal(carol.publicKey.toBase58());
    });

    it("[disabled] rejects approve to a blocklisted delegate (ToAddressBlocked)", async () => {
      await ensureFunded(ctx.off, outsider, 10_000);
      const badDel = Keypair.generate();
      const badAta = await createATA(provider, admin, badDel.publicKey, ctx.off.mint.publicKey);
      await addBlocklist(ctx.off, badDel.publicKey, badAta);
      await expectRevert(
        program.methods
          .approveTokens(new anchor.BN(1_000))
          .accounts(approveAccounts(ctx.off, outsider, badDel.publicKey, null, null) as any)
          .signers([outsider])
          .rpc(),
        "ToAddressBlocked",
      );
      await removeBlocklist(ctx.off, badDel.publicKey);
    });
  });
});
