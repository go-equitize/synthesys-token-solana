/**
 * synthesys-token — roles, pause/unpause, ccip admin & router.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { Ctx, createATA, rolePda, ADMIN_ROLE, MINTER_ROLE, DEFAULT_ADMIN_ROLE, getTokenAccount } from "../synthesys-helpers";
import { getCtx, program, provider, connection, admin, programId, mallory, bl, expectRevert } from "./fixtures";

describe("synthesys-token", () => {
  let ctx: Ctx;
  before(async () => { ctx = await getCtx(); });

  // ===========================================================================
  // J. roles
  // ===========================================================================
  describe("roles", () => {
    it("admin grants MINTER to a new key; that key can mint on the disabled mint; then revoke", async () => {
      const minter = Keypair.generate();
      const sig = await connection.requestAirdrop(minter.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      const minterRole = rolePda(ctx.off.mint.publicKey, MINTER_ROLE, minter.publicKey, programId);

      await program.methods.grantRole("MINTER_ROLE", minter.publicKey).accounts({
        authority: admin.publicKey, payer: admin.publicKey, callerRole: ctx.off.defaultAdminRolePda,
        tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey, roleEntry: minterRole, systemProgram: SystemProgram.programId,
      } as any).rpc();

      const recip = Keypair.generate().publicKey;
      const recipAta = await createATA(provider, admin, recip, ctx.off.mint.publicKey);
      await program.methods.mint(new anchor.BN(1_000)).accounts({
        signer: minter.publicKey, roleEntry: minterRole, tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey,
        recipientTokenAccount: recipAta, recipientWhitelist: null, recipientBlocklist: bl(ctx.off, recip),
        signerWhitelist: null, signerBlocklist: bl(ctx.off, minter.publicKey), authorityPda: ctx.off.authorityPda, tokenProgram: TOKEN_2022_PROGRAM_ID,
      } as any).signers([minter]).rpc();
      expect(Number((await getTokenAccount(connection, recipAta)).amount)).to.equal(1_000);

      await program.methods.revokeRole("MINTER_ROLE", minter.publicKey).accounts({
        authority: admin.publicKey, payer: admin.publicKey, callerRole: ctx.off.defaultAdminRolePda,
        tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey, roleEntry: minterRole,
      } as any).rpc();
      expect(await connection.getAccountInfo(minterRole)).to.be.null;
    });

    it("non-admin cannot grant roles", async () => {
      const target = Keypair.generate().publicKey;
      await expectRevert(
        program.methods.grantRole("MINTER_ROLE", target).accounts({
          authority: mallory.publicKey, payer: mallory.publicKey,
          callerRole: rolePda(ctx.off.mint.publicKey, DEFAULT_ADMIN_ROLE, mallory.publicKey, programId),
          tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey,
          roleEntry: rolePda(ctx.off.mint.publicKey, MINTER_ROLE, target, programId), systemProgram: SystemProgram.programId,
        } as any).signers([mallory]).rpc(),
        /AccountNotInitialized|ConstraintSeeds|custom program error/i,
      );
    });
  });

  // ===========================================================================
  // K. pause / unpause
  // ===========================================================================
  describe("pause / unpause", () => {
    it("non-admin cannot pause", async () => {
      await expectRevert(
        program.methods.pause().accounts({ signer: mallory.publicKey, roleEntry: rolePda(ctx.off.mint.publicKey, ADMIN_ROLE, mallory.publicKey, programId), tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey } as any).signers([mallory]).rpc(),
        /AccountNotInitialized|ConstraintSeeds|custom program error/i,
      );
    });

    it("pause blocks mint; unpause restores it", async () => {
      await program.methods.pause().accounts({ signer: admin.publicKey, roleEntry: ctx.off.adminRolePda, tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey } as any).rpc();
      const u = Keypair.generate();
      const ata = await createATA(provider, admin, u.publicKey, ctx.off.mint.publicKey);
      await expectRevert(
        program.methods.mint(new anchor.BN(1)).accounts({
          signer: admin.publicKey, roleEntry: ctx.off.minterRolePda, tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey,
          recipientTokenAccount: ata, recipientWhitelist: null, recipientBlocklist: bl(ctx.off, u.publicKey),
          signerWhitelist: null, signerBlocklist: ctx.off.adminBl, authorityPda: ctx.off.authorityPda, tokenProgram: TOKEN_2022_PROGRAM_ID,
        } as any).rpc(),
        /AllTransfersPaused|0x1770/i,
      );
      await program.methods.unpause().accounts({ signer: admin.publicKey, roleEntry: ctx.off.adminRolePda, tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey } as any).rpc();
    });
  });

  // ===========================================================================
  // L. ccip admin / router
  // ===========================================================================
  describe("ccip admin & router", () => {
    it("admin sets ccip_admin; non-admin cannot", async () => {
      const newAdmin = Keypair.generate().publicKey;
      await program.methods.setCcipAdmin(newAdmin).accounts({ signer: admin.publicKey, roleEntry: ctx.off.adminRolePda, tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey } as any).rpc();
      expect((await program.account.tokenConfig.fetch(ctx.off.tokenConfig)).ccipAdmin.toBase58()).to.equal(newAdmin.toBase58());

      await expectRevert(
        program.methods.setCcipAdmin(admin.publicKey).accounts({ signer: mallory.publicKey, roleEntry: rolePda(ctx.off.mint.publicKey, ADMIN_ROLE, mallory.publicKey, programId), tokenConfig: ctx.off.tokenConfig, mint: ctx.off.mint.publicKey } as any).signers([mallory]).rpc(),
        /AccountNotInitialized|ConstraintSeeds|custom program error/i,
      );
    });
  });
});
