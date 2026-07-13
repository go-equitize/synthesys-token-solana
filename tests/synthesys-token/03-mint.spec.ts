/**
 * synthesys-token — mint: optional whitelist PDA behaviour + blocklist + caller compliance.
 */
import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { Ctx, getTokenAccount, createATA, whitelistPda, rolePda, MINTER_ROLE } from "../synthesys-helpers";
import { getCtx, program, provider, connection, admin, programId, alice, outsider, wlOpt, bl, mintTo, addBlocklist, removeBlocklist, expectRevert } from "./fixtures";
import { Keypair } from "@solana/web3.js";

describe("synthesys-token", () => {
  let ctx: Ctx;
  before(async () => { ctx = await getCtx(); });

  // ===========================================================================
  // E. mint — optional whitelist PDA behaviour + blocklist + caller compliance
  // ===========================================================================
  describe("mint", () => {
    it("[enabled] mints to a whitelisted recipient", async () => {
      const ata = await mintTo(ctx.on, alice.publicKey, 1_000_000);
      expect(Number((await getTokenAccount(connection, ata)).amount)).to.be.greaterThan(0);
    });

    it("[enabled] rejects mint to a non-whitelisted recipient (ToAddressNotWhitelisted)", async () => {
      const ata = await createATA(provider, admin, outsider.publicKey, ctx.on.mint.publicKey);
      await expectRevert(
        program.methods
          .mint(new anchor.BN(1_000))
          .accounts({
            signer: admin.publicKey,
            roleEntry: ctx.on.minterRolePda,
            tokenConfig: ctx.on.tokenConfig,
            mint: ctx.on.mint.publicKey,
            recipientTokenAccount: ata,
            recipientWhitelist: whitelistPda(ctx.on.mint.publicKey, outsider.publicKey, programId),
            recipientBlocklist: bl(ctx.on, outsider.publicKey),
            signerWhitelist: ctx.on.adminWl,
            signerBlocklist: ctx.on.adminBl,
            authorityPda: ctx.on.authorityPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .rpc(),
        "ToAddressNotWhitelisted",
      );
    });

    it("[enabled] rejects mint when the recipient whitelist PDA is OMITTED (WhitelistAccountMissing)", async () => {
      const ata = await createATA(provider, admin, alice.publicKey, ctx.on.mint.publicKey);
      await expectRevert(
        program.methods
          .mint(new anchor.BN(1_000))
          .accounts({
            signer: admin.publicKey,
            roleEntry: ctx.on.minterRolePda,
            tokenConfig: ctx.on.tokenConfig,
            mint: ctx.on.mint.publicKey,
            recipientTokenAccount: ata,
            recipientWhitelist: null,
            recipientBlocklist: bl(ctx.on, alice.publicKey),
            signerWhitelist: ctx.on.adminWl,
            signerBlocklist: ctx.on.adminBl,
            authorityPda: ctx.on.authorityPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .rpc(),
        "WhitelistAccountMissing",
      );
    });

    it("[enabled] rejects mint when the caller (minter != recipient) is not whitelisted (SenderAddressNotWhitelisted)", async () => {
      // Grant `outsider` MINTER_ROLE but do NOT whitelist them.
      const outsiderMinter = rolePda(ctx.on.mint.publicKey, MINTER_ROLE, outsider.publicKey, programId);
      await program.methods
        .grantRole("MINTER_ROLE", outsider.publicKey)
        .accounts({
          authority: admin.publicKey, payer: admin.publicKey,
          callerRole: ctx.on.defaultAdminRolePda, tokenConfig: ctx.on.tokenConfig,
          mint: ctx.on.mint.publicKey, roleEntry: outsiderMinter, systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const ata = await createATA(provider, admin, alice.publicKey, ctx.on.mint.publicKey);
      await expectRevert(
        program.methods
          .mint(new anchor.BN(1_000))
          .accounts({
            signer: outsider.publicKey,
            roleEntry: outsiderMinter,
            tokenConfig: ctx.on.tokenConfig,
            mint: ctx.on.mint.publicKey,
            recipientTokenAccount: ata,
            recipientWhitelist: wlOpt(ctx.on, alice.publicKey),
            recipientBlocklist: bl(ctx.on, alice.publicKey),
            signerWhitelist: whitelistPda(ctx.on.mint.publicKey, outsider.publicKey, programId),
            signerBlocklist: bl(ctx.on, outsider.publicKey),
            authorityPda: ctx.on.authorityPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .signers([outsider])
          .rpc(),
        "SenderAddressNotWhitelisted",
      );

      await program.methods
        .revokeRole("MINTER_ROLE", outsider.publicKey)
        .accounts({
          authority: admin.publicKey, payer: admin.publicKey,
          callerRole: ctx.on.defaultAdminRolePda, tokenConfig: ctx.on.tokenConfig,
          mint: ctx.on.mint.publicKey, roleEntry: outsiderMinter,
        } as any)
        .rpc();
    });

    it("[disabled] mints to any non-blocklisted recipient without whitelist PDAs (null)", async () => {
      const ata = await mintTo(ctx.off, outsider.publicKey, 1_000_000);
      expect(Number((await getTokenAccount(connection, ata)).amount)).to.be.greaterThan(0);
    });

    it("[disabled] rejects mint to a blocklisted recipient (ToAddressBlocked)", async () => {
      const u = Keypair.generate();
      const ata = await createATA(provider, admin, u.publicKey, ctx.off.mint.publicKey);
      await addBlocklist(ctx.off, u.publicKey, ata);
      await expectRevert(
        program.methods
          .mint(new anchor.BN(1_000))
          .accounts({
            signer: admin.publicKey,
            roleEntry: ctx.off.minterRolePda,
            tokenConfig: ctx.off.tokenConfig,
            mint: ctx.off.mint.publicKey,
            recipientTokenAccount: ata,
            recipientWhitelist: null,
            recipientBlocklist: bl(ctx.off, u.publicKey),
            signerWhitelist: null,
            signerBlocklist: ctx.off.adminBl,
            authorityPda: ctx.off.authorityPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .rpc(),
        "ToAddressBlocked",
      );
      await removeBlocklist(ctx.off, u.publicKey);
    });
  });
});
