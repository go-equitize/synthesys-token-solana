/**
 * synthesys-token — forced_transfer & force_burn: ADMIN-only, full compliance bypass.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { Ctx, Mode, getTokenAccount, createATA, whitelistPda, rolePda, ADMIN_ROLE } from "../synthesys-helpers";
import { getCtx, program, provider, connection, admin, programId, alice, bob, outsider, carol, mallory, wlOpt, bl, ensureFunded, addBlocklist, removeBlocklist, expectRevert } from "./fixtures";

describe("synthesys-token", () => {
  let ctx: Ctx;
  before(async () => { ctx = await getCtx(); });

  // ===========================================================================
  // I. forced_transfer & force_burn — ADMIN-only + full compliance bypass
  // ===========================================================================
  describe("force_burn (admin-only, bypasses compliance)", () => {
    it("[enabled] admin force-burns from a compliant account", async () => {
      const ata = await ensureFunded(ctx.on, alice, 300_000);
      const before = Number((await getTokenAccount(connection, ata)).amount);
      await program.methods
        .forceBurn(new anchor.BN(100_000))
        .accounts({ signer: admin.publicKey, roleEntry: ctx.on.adminRolePda, tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey, targetTokenAccount: ata, authorityPda: ctx.on.authorityPda, tokenProgram: TOKEN_2022_PROGRAM_ID } as any)
        .rpc();
      const after = Number((await getTokenAccount(connection, ata)).amount);
      expect(before - after).to.equal(100_000);
    });

    it("[enabled] admin force-burns from a BLOCKLISTED (frozen) account and re-freezes it (bypasses blocklist)", async () => {
      const victim = Keypair.generate();
      const ata = await ensureFunded(ctx.on, victim, 200_000); // whitelists + funds + thaws
      await addBlocklist(ctx.on, victim.publicKey, ata); // now frozen
      expect((await getTokenAccount(connection, ata)).isFrozen).to.be.true;
      const before = Number((await getTokenAccount(connection, ata)).amount);

      await program.methods
        .forceBurn(new anchor.BN(50_000))
        .accounts({ signer: admin.publicKey, roleEntry: ctx.on.adminRolePda, tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey, targetTokenAccount: ata, authorityPda: ctx.on.authorityPda, tokenProgram: TOKEN_2022_PROGRAM_ID } as any)
        .rpc();

      const acct = await getTokenAccount(connection, ata);
      expect(before - Number(acct.amount)).to.equal(50_000);
      expect(acct.isFrozen, "must be re-frozen after force-burn").to.be.true;
      await removeBlocklist(ctx.on, victim.publicKey);
    });

    it("[enabled] force_burn succeeds while the program is PAUSED (bypasses pause)", async () => {
      const ata = await ensureFunded(ctx.on, alice, 100_000);
      await program.methods.pause().accounts({ signer: admin.publicKey, roleEntry: ctx.on.adminRolePda, tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey } as any).rpc();
      try {
        const before = Number((await getTokenAccount(connection, ata)).amount);
        await program.methods
          .forceBurn(new anchor.BN(10_000))
          .accounts({ signer: admin.publicKey, roleEntry: ctx.on.adminRolePda, tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey, targetTokenAccount: ata, authorityPda: ctx.on.authorityPda, tokenProgram: TOKEN_2022_PROGRAM_ID } as any)
          .rpc();
        const after = Number((await getTokenAccount(connection, ata)).amount);
        expect(before - after).to.equal(10_000);
      } finally {
        await program.methods.unpause().accounts({ signer: admin.publicKey, roleEntry: ctx.on.adminRolePda, tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey } as any).rpc();
      }
    });

    it("rejects force_burn from a NON-admin (both a fake-role signer and a real non-admin)", async () => {
      const ata = await ensureFunded(ctx.on, alice, 100_000);
      // mallory holds no ADMIN_ROLE PDA → the role_entry account does not exist.
      await expectRevert(
        program.methods
          .forceBurn(new anchor.BN(1_000))
          .accounts({ signer: mallory.publicKey, roleEntry: rolePda(ctx.on.mint.publicKey, ADMIN_ROLE, mallory.publicKey, programId), tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey, targetTokenAccount: ata, authorityPda: ctx.on.authorityPda, tokenProgram: TOKEN_2022_PROGRAM_ID } as any)
          .signers([mallory])
          .rpc(),
        /AccountNotInitialized|ConstraintSeeds|custom program error/i,
      );
      // mallory tries to pass the ADMIN's role PDA but cannot sign as admin / the seeds bind to signer.
      await expectRevert(
        program.methods
          .forceBurn(new anchor.BN(1_000))
          .accounts({ signer: mallory.publicKey, roleEntry: ctx.on.adminRolePda, tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey, targetTokenAccount: ata, authorityPda: ctx.on.authorityPda, tokenProgram: TOKEN_2022_PROGRAM_ID } as any)
          .signers([mallory])
          .rpc(),
        /ConstraintSeeds|AccountNotInitialized|custom program error/i,
      );
    });
  });

  describe("forced_transfer (admin-only, bypasses compliance)", () => {
    // Build forced_transfer accounts for a given (from,to) pair.
    function ftAccounts(mode: Mode, fromOwner: PublicKey, toOwner: PublicKey, fromAta: PublicKey, toAta: PublicKey, opts?: { fromWl?: PublicKey | null; toWl?: PublicKey | null; signer?: PublicKey; roleEntry?: PublicKey }) {
      return {
        signer: opts?.signer ?? admin.publicKey,
        roleEntry: opts?.roleEntry ?? mode.adminRolePda,
        tokenConfig: mode.tokenConfig,
        mint: mode.mint.publicKey,
        fromTokenAccount: fromAta,
        toTokenAccount: toAta,
        authorityPda: mode.authorityPda,
        fromOwnerWhitelist: opts && "fromWl" in opts ? opts.fromWl! : wlOpt(mode, fromOwner),
        fromOwnerBlocklist: bl(mode, fromOwner),
        toOwnerWhitelist: opts && "toWl" in opts ? opts.toWl! : wlOpt(mode, toOwner),
        toOwnerBlocklist: bl(mode, toOwner),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      };
    }

    it("[enabled] moves value between two compliant accounts and clears the bypass flag", async () => {
      const fromAta = await ensureFunded(ctx.on, alice, 300_000);
      const toAta = await ensureFunded(ctx.on, bob, 1);
      const fromBefore = Number((await getTokenAccount(connection, fromAta)).amount);
      const toBefore = Number((await getTokenAccount(connection, toAta)).amount);

      await program.methods.forcedTransfer(new anchor.BN(120_000)).accounts(ftAccounts(ctx.on, alice.publicKey, bob.publicKey, fromAta, toAta) as any).rpc();

      expect(fromBefore - Number((await getTokenAccount(connection, fromAta)).amount)).to.equal(120_000);
      expect(Number((await getTokenAccount(connection, toAta)).amount) - toBefore).to.equal(120_000);
      const cfg = await program.account.tokenConfig.fetch(ctx.on.tokenConfig);
      expect(cfg.bypassingCompliance).to.be.false;
    });

    it("[enabled] BYPASSES whitelist: moves value to a NON-whitelisted, frozen recipient and re-freezes it", async () => {
      const fromAta = await ensureFunded(ctx.on, alice, 300_000);
      // outsider is NOT whitelisted on the on-mint; their ATA is frozen (never thawed).
      const toAta = await createATA(provider, admin, outsider.publicKey, ctx.on.mint.publicKey);
      expect((await getTokenAccount(connection, toAta)).isFrozen).to.be.true;
      const toBefore = Number((await getTokenAccount(connection, toAta)).amount);

      // Whitelist accounts are PASSED (mandatory when enabled) — but existence is NOT required:
      // the outsider whitelist PDA does not exist, yet the transfer still lands (bypass).
      await program.methods
        .forcedTransfer(new anchor.BN(70_000))
        .accounts(ftAccounts(ctx.on, alice.publicKey, outsider.publicKey, fromAta, toAta, {
          fromWl: whitelistPda(ctx.on.mint.publicKey, alice.publicKey, programId),
          toWl: whitelistPda(ctx.on.mint.publicKey, outsider.publicKey, programId),
        }) as any)
        .rpc();

      const acct = await getTokenAccount(connection, toAta);
      expect(Number(acct.amount) - toBefore).to.equal(70_000);
      expect(acct.isFrozen, "non-whitelisted recipient must be re-frozen").to.be.true;
    });

    it("[enabled] requires the whitelist PDA account to be PASSED (WhitelistAccountMissing) even though it bypasses existence", async () => {
      const fromAta = await ensureFunded(ctx.on, alice, 100_000);
      const toAta = await ensureFunded(ctx.on, bob, 1);
      await expectRevert(
        program.methods
          .forcedTransfer(new anchor.BN(1_000))
          .accounts(ftAccounts(ctx.on, alice.publicKey, bob.publicKey, fromAta, toAta, { fromWl: null, toWl: wlOpt(ctx.on, bob.publicKey) }) as any)
          .rpc(),
        "WhitelistAccountMissing",
      );
    });

    it("[enabled] succeeds while PAUSED (bypasses pause)", async () => {
      const fromAta = await ensureFunded(ctx.on, alice, 100_000);
      const toAta = await ensureFunded(ctx.on, bob, 1);
      await program.methods.pause().accounts({ signer: admin.publicKey, roleEntry: ctx.on.adminRolePda, tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey } as any).rpc();
      try {
        const fromBefore = Number((await getTokenAccount(connection, fromAta)).amount);
        await program.methods.forcedTransfer(new anchor.BN(20_000)).accounts(ftAccounts(ctx.on, alice.publicKey, bob.publicKey, fromAta, toAta) as any).rpc();
        expect(fromBefore - Number((await getTokenAccount(connection, fromAta)).amount)).to.equal(20_000);
      } finally {
        await program.methods.unpause().accounts({ signer: admin.publicKey, roleEntry: ctx.on.adminRolePda, tokenConfig: ctx.on.tokenConfig, mint: ctx.on.mint.publicKey } as any).rpc();
      }
    });

    it("rejects from == to (CannotTransferToSelf)", async () => {
      const ata = await ensureFunded(ctx.on, alice, 10_000);
      await expectRevert(
        program.methods.forcedTransfer(new anchor.BN(1)).accounts(ftAccounts(ctx.on, alice.publicKey, alice.publicKey, ata, ata) as any).rpc(),
        "CannotTransferToSelf",
      );
    });

    it("rejects forced_transfer from a NON-admin", async () => {
      const fromAta = await ensureFunded(ctx.on, alice, 10_000);
      const toAta = await ensureFunded(ctx.on, bob, 1);
      await expectRevert(
        program.methods
          .forcedTransfer(new anchor.BN(1_000))
          .accounts(ftAccounts(ctx.on, alice.publicKey, bob.publicKey, fromAta, toAta, { signer: mallory.publicKey, roleEntry: rolePda(ctx.on.mint.publicKey, ADMIN_ROLE, mallory.publicKey, programId) }) as any)
          .signers([mallory])
          .rpc(),
        /AccountNotInitialized|ConstraintSeeds|custom program error/i,
      );
    });

    it("[disabled] moves value with null whitelist PDAs and bypasses a blocklisted/frozen source", async () => {
      const fromAta = await ensureFunded(ctx.off, outsider, 200_000);
      const toAta = await ensureFunded(ctx.off, carol, 1);
      await addBlocklist(ctx.off, outsider.publicKey, fromAta); // freeze source
      expect((await getTokenAccount(connection, fromAta)).isFrozen).to.be.true;

      const fromBefore = Number((await getTokenAccount(connection, fromAta)).amount);
      await program.methods
        .forcedTransfer(new anchor.BN(60_000))
        .accounts(ftAccounts(ctx.off, outsider.publicKey, carol.publicKey, fromAta, toAta, { fromWl: null, toWl: null }) as any)
        .rpc();

      const fromAfter = await getTokenAccount(connection, fromAta);
      expect(fromBefore - Number(fromAfter.amount)).to.equal(60_000);
      expect(fromAfter.isFrozen, "blocklisted source must be re-frozen").to.be.true;
      await removeBlocklist(ctx.off, outsider.publicKey);
    });
  });
});
