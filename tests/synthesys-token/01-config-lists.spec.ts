/**
 * synthesys-token — initialize/config, whitelist management, blocklist management.
 * See tests/synthesys-token.ts's original header comment for the full suite rationale.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { Ctx, findPDA, getTokenAccount, createSynthesysMint, createATA, TOKEN_CONFIG_SEED, rolePda, ADMIN_ROLE, MINTER_ROLE, BURNER_ROLE, DEFAULT_ADMIN_ROLE, AUTHORITY_SEED, whitelistPda } from "../synthesys-helpers";
import { getCtx, program, provider, connection, admin, programId, carol, mallory, addBlocklist, removeBlocklist, bl, expectRevert } from "./fixtures";

describe("synthesys-token", () => {
  let ctx: Ctx;
  before(async () => { ctx = await getCtx(); });

  // ===========================================================================
  // A. initialize & immutable whitelist mode
  // ===========================================================================
  describe("initialize & config", () => {
    it("whitelist-enabled mint: config records whitelist_enabled = true", async () => {
      const cfg = await program.account.tokenConfig.fetch(ctx.on.tokenConfig);
      expect(cfg.whitelistEnabled).to.be.true;
      expect(cfg.paused).to.be.false;
      expect(cfg.mint.toBase58()).to.equal(ctx.on.mint.publicKey.toBase58());
      expect(cfg.defaultAdmin.toBase58()).to.equal(admin.publicKey.toBase58());
    });

    it("whitelist-disabled mint: config records whitelist_enabled = false", async () => {
      const cfg = await program.account.tokenConfig.fetch(ctx.off.tokenConfig);
      expect(cfg.whitelistEnabled).to.be.false;
    });

    it("rejects zero-address admin", async () => {
      const badMint = await createSynthesysMint(provider, admin, programId);
      const m = badMint.publicKey;
      const zero = PublicKey.default;
      await expectRevert(
        program.methods
          .initialize(zero, admin.publicKey, true)
          .accounts({
            authority: admin.publicKey,
            payer: admin.publicKey,
            mint: m,
            tokenConfig: findPDA([TOKEN_CONFIG_SEED, m.toBuffer()], programId)[0],
            adminRoleEntry: rolePda(m, ADMIN_ROLE, zero, programId),
            minterRoleEntry: rolePda(m, MINTER_ROLE, zero, programId),
            burnerRoleEntry: rolePda(m, BURNER_ROLE, zero, programId),
            defaultAdminRoleEntry: rolePda(m, DEFAULT_ADMIN_ROLE, zero, programId),
            authorityPda: findPDA([AUTHORITY_SEED, m.toBuffer()], programId)[0],
            programConfig: null,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc(),
        "ZeroAddressAdmin",
      );
    });

    it("re-initializing an already-initialized mint fails (config PDA already exists)", async () => {
      await expectRevert(
        program.methods
          .initialize(admin.publicKey, admin.publicKey, true)
          .accounts({
            authority: admin.publicKey,
            payer: admin.publicKey,
            mint: ctx.on.mint.publicKey,
            tokenConfig: ctx.on.tokenConfig,
            adminRoleEntry: ctx.on.adminRolePda,
            minterRoleEntry: ctx.on.minterRolePda,
            burnerRoleEntry: ctx.on.burnerRolePda,
            defaultAdminRoleEntry: ctx.on.defaultAdminRolePda,
            authorityPda: ctx.on.authorityPda,
            programConfig: null,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc(),
        /already in use|custom program error/i,
      );
    });

    it("whitelist_enabled is immutable: no instruction other than initialize can set it", () => {
      // Structural guarantee — audit-relevant. The only instruction carrying a
      // whitelist_enabled argument is `initialize`; there is deliberately no setter.
      const setters = (program.idl.instructions as any[]).filter(
        (i) => i.name !== "initialize" && (i.args ?? []).some((a: any) => a.name === "whitelistEnabled" || a.name === "whitelist_enabled"),
      );
      expect(setters, "found an instruction that mutates whitelist_enabled").to.have.length(0);
    });
  });

  // ===========================================================================
  // B. whitelist management — enabled vs disabled
  // ===========================================================================
  describe("whitelist management", () => {
    it("[enabled] admin can add and it creates the PDA", async () => {
      const wl = whitelistPda(ctx.on.mint.publicKey, carol.publicKey, programId);
      expect(await connection.getAccountInfo(wl)).to.not.be.null; // carol whitelisted in before()
    });

    it("[enabled] non-admin cannot add to whitelist", async () => {
      const target = Keypair.generate().publicKey;
      await expectRevert(
        program.methods
          .addWhitelist(target)
          .accounts({
            authority: mallory.publicKey,
            payer: mallory.publicKey,
            roleEntry: rolePda(ctx.on.mint.publicKey, ADMIN_ROLE, mallory.publicKey, programId),
            tokenConfig: ctx.on.tokenConfig,
            mint: ctx.on.mint.publicKey,
            whitelistEntry: whitelistPda(ctx.on.mint.publicKey, target, programId),
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([mallory])
          .rpc(),
        /AccountNotInitialized|ConstraintSeeds|Unauthorized|custom program error/i,
      );
    });

    it("[disabled] add_whitelist is rejected with WhitelistNotEnabled", async () => {
      const target = Keypair.generate().publicKey;
      await expectRevert(
        program.methods
          .addWhitelist(target)
          .accounts({
            authority: admin.publicKey,
            payer: admin.publicKey,
            roleEntry: ctx.off.adminRolePda,
            tokenConfig: ctx.off.tokenConfig,
            mint: ctx.off.mint.publicKey,
            whitelistEntry: whitelistPda(ctx.off.mint.publicKey, target, programId),
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc(),
        "WhitelistNotEnabled",
      );
    });

    it("[disabled] remove_whitelist is impossible (no entry can exist → rejected)", async () => {
      // On a disabled mint no whitelist entry can EVER be created (add_whitelist always
      // reverts), so remove_whitelist is structurally unreachable: Anchor's `close`
      // constraint rejects the non-existent whitelist_entry with AccountNotInitialized
      // before the handler's WhitelistNotEnabled guard is even reached. Either way the
      // instruction is firmly rejected — which is the property that matters.
      const target = Keypair.generate().publicKey;
      const ata = await createATA(provider, admin, target, ctx.off.mint.publicKey);
      await expectRevert(
        program.methods
          .removeWhitelist(target)
          .accounts({
            authority: admin.publicKey,
            payer: admin.publicKey,
            roleEntry: ctx.off.adminRolePda,
            tokenConfig: ctx.off.tokenConfig,
            mint: ctx.off.mint.publicKey,
            whitelistEntry: whitelistPda(ctx.off.mint.publicKey, target, programId),
            authorityPda: ctx.off.authorityPda,
            targetTokenAccount: ata,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          } as any)
          .rpc(),
        /WhitelistNotEnabled|AccountNotInitialized/,
      );
    });
  });

  // ===========================================================================
  // C. blocklist management — identical in both modes
  // ===========================================================================
  describe("blocklist management (mode-independent)", () => {
    for (const which of ["on", "off"] as const) {
      it(`[${which}] add freezes the account, remove is admin-gated`, async () => {
        const mode = ctx[which];
        const u = Keypair.generate();
        const ata = await createATA(provider, admin, u.publicKey, mode.mint.publicKey);
        await addBlocklist(mode, u.publicKey, ata);
        expect((await getTokenAccount(connection, ata)).isFrozen).to.be.true;
        expect(await connection.getAccountInfo(bl(mode, u.publicKey))).to.not.be.null;

        // non-admin cannot remove
        await expectRevert(
          program.methods
            .removeBlocklist(u.publicKey)
            .accounts({
              authority: mallory.publicKey,
              payer: mallory.publicKey,
              roleEntry: rolePda(mode.mint.publicKey, ADMIN_ROLE, mallory.publicKey, programId),
              tokenConfig: mode.tokenConfig,
              mint: mode.mint.publicKey,
              blocklistEntry: bl(mode, u.publicKey),
            } as any)
            .signers([mallory])
            .rpc(),
          /AccountNotInitialized|ConstraintSeeds|custom program error/i,
        );

        await removeBlocklist(mode, u.publicKey);
        expect(await connection.getAccountInfo(bl(mode, u.publicKey))).to.be.null;
      });
    }
  });
});
