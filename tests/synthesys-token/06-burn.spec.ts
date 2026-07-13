/**
 * synthesys-token — burn (self / account / from).
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAccount } from "@solana/spl-token";
import { expect } from "chai";
import { Ctx, getTokenAccount, rolePda, BURNER_ROLE } from "../synthesys-helpers";
import { getCtx, program, connection, admin, programId, alice, bob, carol, wlOpt, bl, ensureFunded, addWhitelist, addBlocklist, removeBlocklist, expectRevert } from "./fixtures";

describe("synthesys-token", () => {
  let ctx: Ctx;
  before(async () => { ctx = await getCtx(); });

  // ===========================================================================
  // H. burn (self / account / from)
  // ===========================================================================
  describe("burn", () => {
    it("[enabled] burn_self burns from the caller's own account", async () => {
      const ata = await ensureFunded(ctx.on, alice, 200_000);
      const before = Number((await getTokenAccount(connection, ata)).amount);
      const burnSelfAccounts = {
        signer: alice.publicKey,
        roleEntry: rolePda(ctx.on.mint.publicKey, BURNER_ROLE, alice.publicKey, programId),
        tokenConfig: ctx.on.tokenConfig,
        mint: ctx.on.mint.publicKey,
        signerTokenAccount: ata,
        signerWhitelist: wlOpt(ctx.on, alice.publicKey),
        signerOwnerBlocklist: bl(ctx.on, alice.publicKey),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      };
      await program.methods
        .burnSelf(new anchor.BN(50_000))
        .accounts(burnSelfAccounts as any)
        .signers([alice])
        .rpc()
        .catch(async (e) => {
          // alice needs BURNER_ROLE; grant then retry once.
          await program.methods.grantRole("BURNER_ROLE", alice.publicKey).accounts({
            authority: admin.publicKey, payer: admin.publicKey, callerRole: ctx.on.defaultAdminRolePda,
            tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey,
            roleEntry: rolePda(ctx.on.mint.publicKey, BURNER_ROLE, alice.publicKey, programId), systemProgram: SystemProgram.programId,
          } as any).rpc();
          await program.methods.burnSelf(new anchor.BN(50_000)).accounts(burnSelfAccounts as any).signers([alice]).rpc();
        });
      const after = Number((await getTokenAccount(connection, ata)).amount);
      expect(before - after).to.equal(50_000);
    });

    it("[enabled] burn_account by BURNER (caller != owner) requires the caller be whitelisted; OMITTING it reverts WhitelistAccountMissing", async () => {
      const ata = await ensureFunded(ctx.on, bob, 100_000);
      // admin is BURNER + whitelisted; caller(admin) != owner(bob) → caller compliance applies.
      await expectRevert(
        program.methods
          .burnAccount(new anchor.BN(1_000))
          .accounts({
            signer: admin.publicKey,
            roleEntry: ctx.on.burnerRolePda,
            tokenConfig: ctx.on.tokenConfig,
            mint: ctx.on.mint.publicKey,
            fromTokenAccount: ata,
            signerWhitelist: null, // omitted → None while enabled
            signerBlocklist: ctx.on.adminBl,
            ownerWhitelist: wlOpt(ctx.on, bob.publicKey),
            ownerBlocklist: bl(ctx.on, bob.publicKey),
            authorityPda: ctx.on.authorityPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .rpc(),
        "WhitelistAccountMissing",
      );
    });

    it("[enabled] burn_account by BURNER succeeds when the caller whitelist PDA is supplied", async () => {
      const ata = await ensureFunded(ctx.on, bob, 100_000);
      const before = Number((await getTokenAccount(connection, ata)).amount);
      await program.methods
        .burnAccount(new anchor.BN(40_000))
        .accounts({
          signer: admin.publicKey,
          roleEntry: ctx.on.burnerRolePda,
          tokenConfig: ctx.on.tokenConfig,
          mint: ctx.on.mint.publicKey,
          fromTokenAccount: ata,
          signerWhitelist: ctx.on.adminWl,
          signerBlocklist: ctx.on.adminBl,
          ownerWhitelist: wlOpt(ctx.on, bob.publicKey),
          ownerBlocklist: bl(ctx.on, bob.publicKey),
          authorityPda: ctx.on.authorityPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        } as any)
        .rpc();
      const after = Number((await getTokenAccount(connection, ata)).amount);
      expect(before - after).to.equal(40_000);
    });

    it("[disabled] burn_account by BURNER (caller != owner) needs no whitelist PDA", async () => {
      const ata = await ensureFunded(ctx.off, carol, 100_000);
      const before = Number((await getTokenAccount(connection, ata)).amount);
      await program.methods
        .burnAccount(new anchor.BN(30_000))
        .accounts({
          signer: admin.publicKey,
          roleEntry: ctx.off.burnerRolePda,
          tokenConfig: ctx.off.tokenConfig,
          mint: ctx.off.mint.publicKey,
          fromTokenAccount: ata,
          signerWhitelist: null,
          signerBlocklist: ctx.off.adminBl,
          ownerWhitelist: null,
          ownerBlocklist: bl(ctx.off, carol.publicKey),
          authorityPda: ctx.off.authorityPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        } as any)
        .rpc();
      const after = Number((await getTokenAccount(connection, ata)).amount);
      expect(before - after).to.equal(30_000);
    });

    // -------------------------------------------------------------------------
    // Multi-ATA owner-compliance regression (closes the burn-side counterpart of
    // the transfer-hook's multi-ATA compliance gap): freeze state is per-ATA, but
    // compliance is per-owner. add_blocklist only freezes the ONE token account it's
    // given, so a blocklisted owner's OTHER thawed ATA must still be unburnable via
    // burn_account — proving owner compliance is enforced independently of freeze state.
    // -------------------------------------------------------------------------
    it("[enabled] burn_account on a blocklisted owner's OTHER thawed ATA reverts (FromAddressBlocked)", async () => {
      const holder = Keypair.generate();
      await addWhitelist(ctx.on, holder.publicKey);

      // ata1: funded + thawed normally (this is the ATA add_blocklist will freeze).
      const ata1 = await ensureFunded(ctx.on, holder, 10_000);

      // ata2: a SECOND, non-associated token account for the same owner — minting into it
      // auto-thaws it (mint_handler thaws any compliant, frozen recipient token account).
      const ata2Kp = Keypair.generate();
      const ata2 = await createAccount(
        connection, admin, ctx.on.mint.publicKey, holder.publicKey, ata2Kp, undefined, TOKEN_2022_PROGRAM_ID,
      );
      await program.methods
        .mint(new anchor.BN(10_000))
        .accounts({
          signer: admin.publicKey,
          roleEntry: ctx.on.minterRolePda,
          tokenConfig: ctx.on.tokenConfig,
          mint: ctx.on.mint.publicKey,
          recipientTokenAccount: ata2,
          recipientWhitelist: wlOpt(ctx.on, holder.publicKey),
          recipientBlocklist: bl(ctx.on, holder.publicKey),
          signerWhitelist: wlOpt(ctx.on, admin.publicKey),
          signerBlocklist: ctx.on.adminBl,
          authorityPda: ctx.on.authorityPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        } as any)
        .rpc();

      // Blocklist the owner — add_blocklist freezes only ata1 (the account it's given).
      await addBlocklist(ctx.on, holder.publicKey, ata1);
      expect((await getTokenAccount(connection, ata2)).isFrozen).to.be.false;

      // ata2 is still thawed, but burn_account must still refuse it: owner compliance is
      // now re-derived and checked independently of ata2's (thawed) freeze state.
      await expectRevert(
        program.methods
          .burnAccount(new anchor.BN(1_000))
          .accounts({
            signer: admin.publicKey,
            roleEntry: ctx.on.burnerRolePda,
            tokenConfig: ctx.on.tokenConfig,
            mint: ctx.on.mint.publicKey,
            fromTokenAccount: ata2,
            signerWhitelist: wlOpt(ctx.on, admin.publicKey),
            signerBlocklist: ctx.on.adminBl,
            ownerWhitelist: wlOpt(ctx.on, holder.publicKey),
            ownerBlocklist: bl(ctx.on, holder.publicKey),
            authorityPda: ctx.on.authorityPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .rpc(),
        "FromAddressBlocked",
      );

      await removeBlocklist(ctx.on, holder.publicKey);
    });
  });
});
