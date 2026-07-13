/**
 * synthesys-token — thaw_token_account: optional whitelist PDA behaviour.
 */
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { Ctx, getTokenAccount, createATA, whitelistPda } from "../synthesys-helpers";
import { getCtx, program, provider, connection, admin, programId, alice, carol, outsider, wlOpt, bl, addBlocklist, removeBlocklist, expectRevert } from "./fixtures";

describe("synthesys-token", () => {
  let ctx: Ctx;
  before(async () => { ctx = await getCtx(); });

  // ===========================================================================
  // D. thaw — optional whitelist PDA behaviour
  // ===========================================================================
  describe("thaw_token_account", () => {
    it("[enabled] thaws a whitelisted, non-blocklisted account", async () => {
      const ata = await createATA(provider, admin, alice.publicKey, ctx.on.mint.publicKey);
      if ((await getTokenAccount(connection, ata)).isFrozen) {
        await program.methods
          .thawTokenAccount()
          .accounts({
            signer: admin.publicKey,
            tokenConfig: ctx.on.tokenConfig,
            mint: ctx.on.mint.publicKey,
            tokenAccount: ata,
            ownerWhitelist: wlOpt(ctx.on, alice.publicKey),
            ownerBlocklist: bl(ctx.on, alice.publicKey),
            authorityPda: ctx.on.authorityPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .rpc();
      }
      expect((await getTokenAccount(connection, ata)).isFrozen).to.be.false;
    });

    it("[enabled] rejects thaw for a non-whitelisted owner (FromAddressNotWhitelisted)", async () => {
      const ata = await createATA(provider, admin, outsider.publicKey, ctx.on.mint.publicKey);
      await expectRevert(
        program.methods
          .thawTokenAccount()
          .accounts({
            signer: admin.publicKey,
            tokenConfig: ctx.on.tokenConfig,
            mint: ctx.on.mint.publicKey,
            tokenAccount: ata,
            ownerWhitelist: whitelistPda(ctx.on.mint.publicKey, outsider.publicKey, programId),
            ownerBlocklist: bl(ctx.on, outsider.publicKey),
            authorityPda: ctx.on.authorityPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .rpc(),
        "FromAddressNotWhitelisted",
      );
    });

    it("[enabled] rejects thaw when the whitelist PDA is OMITTED (WhitelistAccountMissing)", async () => {
      const ata = await createATA(provider, admin, alice.publicKey, ctx.on.mint.publicKey);
      await expectRevert(
        program.methods
          .thawTokenAccount()
          .accounts({
            signer: admin.publicKey,
            tokenConfig: ctx.on.tokenConfig,
            mint: ctx.on.mint.publicKey,
            tokenAccount: ata,
            ownerWhitelist: null, // omitted → None
            ownerBlocklist: bl(ctx.on, alice.publicKey),
            authorityPda: ctx.on.authorityPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .rpc(),
        "WhitelistAccountMissing",
      );
    });

    it("[disabled] thaws ANY non-blocklisted account without a whitelist PDA (null)", async () => {
      const ata = await createATA(provider, admin, outsider.publicKey, ctx.off.mint.publicKey);
      await program.methods
        .thawTokenAccount()
        .accounts({
          signer: admin.publicKey,
          tokenConfig: ctx.off.tokenConfig,
          mint: ctx.off.mint.publicKey,
          tokenAccount: ata,
          ownerWhitelist: null,
          ownerBlocklist: bl(ctx.off, outsider.publicKey),
          authorityPda: ctx.off.authorityPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        } as any)
        .rpc();
      expect((await getTokenAccount(connection, ata)).isFrozen).to.be.false;
    });

    it("[disabled] ignores a whitelist PDA even if one is passed (still succeeds)", async () => {
      const ata = await createATA(provider, admin, carol.publicKey, ctx.off.mint.publicKey);
      await program.methods
        .thawTokenAccount()
        .accounts({
          signer: admin.publicKey,
          tokenConfig: ctx.off.tokenConfig,
          mint: ctx.off.mint.publicKey,
          tokenAccount: ata,
          // carol has no whitelist PDA on the off-mint; passing the (empty) address is ignored.
          ownerWhitelist: whitelistPda(ctx.off.mint.publicKey, carol.publicKey, programId),
          ownerBlocklist: bl(ctx.off, carol.publicKey),
          authorityPda: ctx.off.authorityPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        } as any)
        .rpc();
      expect((await getTokenAccount(connection, ata)).isFrozen).to.be.false;
    });

    it("[disabled] still rejects thaw for a blocklisted owner (FromAddressBlocked)", async () => {
      const u = Keypair.generate();
      const ata = await createATA(provider, admin, u.publicKey, ctx.off.mint.publicKey);
      await addBlocklist(ctx.off, u.publicKey, ata);
      await expectRevert(
        program.methods
          .thawTokenAccount()
          .accounts({
            signer: admin.publicKey,
            tokenConfig: ctx.off.tokenConfig,
            mint: ctx.off.mint.publicKey,
            tokenAccount: ata,
            ownerWhitelist: null,
            ownerBlocklist: bl(ctx.off, u.publicKey),
            authorityPda: ctx.off.authorityPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .rpc(),
        "FromAddressBlocked",
      );
      await removeBlocklist(ctx.off, u.publicKey);
    });
  });
});
