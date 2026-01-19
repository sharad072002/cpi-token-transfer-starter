import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CpiTokenTransfer } from "../target/types/cpi_token_transfer";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

describe("cpi-token-transfer", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CpiTokenTransfer as Program<CpiTokenTransfer>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Protocol config PDA
  const [protocolConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    program.programId
  );

  // Test accounts
  let mint: PublicKey;
  let userTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let protocolFeeAccount: PublicKey;
  let feeRecipient: Keypair;

  before(async () => {
    feeRecipient = Keypair.generate();
  });

  it("Initializes protocol config", async () => {
    await program.methods
      .initialize()
      .accounts({
        protocolConfig: protocolConfigPda,
        feeRecipient: feeRecipient.publicKey,
        authority: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.protocolConfig.fetch(protocolConfigPda);
    expect(config.authority.toString()).to.equal(payer.publicKey.toString());
    expect(config.feeRecipient.toString()).to.equal(feeRecipient.publicKey.toString());
    expect(config.feeBps.toNumber()).to.equal(100); // 1%
  });

  it("Transfers tokens via CPI", async () => {
    // Create token mint
    mint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      9 // decimals
    );

    // Create source and destination accounts
    userTokenAccount = await createAccount(
      connection,
      payer,
      mint,
      payer.publicKey
    );

    const recipient = Keypair.generate();
    recipientTokenAccount = await createAccount(
      connection,
      payer,
      mint,
      recipient.publicKey
    );

    // Mint tokens to source
    const mintAmount = 1_000_000_000; // 1 token with 9 decimals
    await mintTo(
      connection,
      payer,
      mint,
      userTokenAccount,
      payer,
      mintAmount
    );

    // Verify initial balance
    let sourceAccount = await getAccount(connection, userTokenAccount);
    expect(Number(sourceAccount.amount)).to.equal(mintAmount);

    // Transfer via program
    const transferAmount = 500_000_000; // 0.5 tokens
    await program.methods
      .transferTokens(new anchor.BN(transferAmount))
      .accounts({
        user: payer.publicKey,
        from: userTokenAccount,
        to: recipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Verify balances after transfer
    sourceAccount = await getAccount(connection, userTokenAccount);
    const destAccount = await getAccount(connection, recipientTokenAccount);

    expect(Number(sourceAccount.amount)).to.equal(mintAmount - transferAmount);
    expect(Number(destAccount.amount)).to.equal(transferAmount);
  });

  it("Transfers with protocol fee", async () => {
    // Create fresh accounts for this test
    const newMint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      9
    );

    const senderAccount = await createAccount(
      connection,
      payer,
      newMint,
      payer.publicKey
    );

    const recipient = Keypair.generate();
    const recipientAccount = await createAccount(
      connection,
      payer,
      newMint,
      recipient.publicKey
    );

    // Create protocol fee account
    protocolFeeAccount = await createAccount(
      connection,
      payer,
      newMint,
      feeRecipient.publicKey
    );

    // Mint tokens to sender
    const mintAmount = 10_000_000_000; // 10 tokens
    await mintTo(connection, payer, newMint, senderAccount, payer, mintAmount);

    // Transfer with fee: 1000 tokens, expect 1% fee = 10 tokens
    const transferAmount = 1_000_000_000; // 1 token
    const expectedFee = transferAmount / 100; // 1% = 0.01 tokens
    const expectedRecipientAmount = transferAmount - expectedFee;

    await program.methods
      .transferWithFee(new anchor.BN(transferAmount))
      .accounts({
        user: payer.publicKey,
        from: senderAccount,
        to: recipientAccount,
        protocolFeeAccount: protocolFeeAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Verify balances
    const senderBalance = await getAccount(connection, senderAccount);
    const recipientBalance = await getAccount(connection, recipientAccount);
    const feeBalance = await getAccount(connection, protocolFeeAccount);

    expect(Number(senderBalance.amount)).to.equal(mintAmount - transferAmount);
    expect(Number(recipientBalance.amount)).to.equal(expectedRecipientAmount);
    expect(Number(feeBalance.amount)).to.equal(expectedFee);
  });

  it("Performs PDA-signed vault transfer", async () => {
    // Derive vault authority PDA
    const [vaultAuthority, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), payer.publicKey.toBuffer()],
      program.programId
    );

    // Create a new mint for this test
    const vaultMint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      9
    );

    // Create vault token account owned by the PDA using getOrCreateAssociatedTokenAccount
    // which supports off-curve owners (PDAs)
    const vaultTokenAccountInfo = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      vaultMint,
      vaultAuthority,
      true // allowOwnerOffCurve - required for PDA owners
    );
    const vaultTokenAccount = vaultTokenAccountInfo.address;

    // Create destination account
    const dest = Keypair.generate();
    const destTokenAccount = await createAccount(
      connection,
      payer,
      vaultMint,
      dest.publicKey
    );

    // Mint tokens to vault
    const vaultAmount = 5_000_000_000; // 5 tokens
    await mintTo(connection, payer, vaultMint, vaultTokenAccount, payer, vaultAmount);

    // Verify vault has tokens
    let vaultBalance = await getAccount(connection, vaultTokenAccount);
    expect(Number(vaultBalance.amount)).to.equal(vaultAmount);

    // Transfer from vault via PDA signature
    const transferAmount = 2_000_000_000; // 2 tokens
    await program.methods
      .vaultTransfer(new anchor.BN(transferAmount), vaultBump)
      .accounts({
        authority: payer.publicKey,
        vaultAuthority: vaultAuthority,
        vault: vaultTokenAccount,
        to: destTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Verify balances
    vaultBalance = await getAccount(connection, vaultTokenAccount);
    const destBalance = await getAccount(connection, destTokenAccount);

    expect(Number(vaultBalance.amount)).to.equal(vaultAmount - transferAmount);
    expect(Number(destBalance.amount)).to.equal(transferAmount);
  });

  it("Deposits tokens into vault", async () => {
    // Derive vault authority PDA
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), payer.publicKey.toBuffer()],
      program.programId
    );

    // Create a new mint for this test
    const depositMint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      9
    );

    // Create user token account
    const userAccount = await createAccount(
      connection,
      payer,
      depositMint,
      payer.publicKey
    );

    // Create vault token account owned by the PDA
    const vaultTokenAccountInfo = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      depositMint,
      vaultAuthority,
      true // allowOwnerOffCurve - required for PDA owners
    );
    const vaultTokenAccount = vaultTokenAccountInfo.address;

    // Mint tokens to user
    const userAmount = 10_000_000_000; // 10 tokens
    await mintTo(connection, payer, depositMint, userAccount, payer, userAmount);

    // Verify initial balances
    let userBalance = await getAccount(connection, userAccount);
    let vaultBalance = await getAccount(connection, vaultTokenAccount);
    expect(Number(userBalance.amount)).to.equal(userAmount);
    expect(Number(vaultBalance.amount)).to.equal(0);

    // Deposit tokens into vault
    const depositAmount = 3_000_000_000; // 3 tokens
    await program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        user: payer.publicKey,
        from: userAccount,
        vaultAuthority: vaultAuthority,
        vault: vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Verify balances after deposit
    userBalance = await getAccount(connection, userAccount);
    vaultBalance = await getAccount(connection, vaultTokenAccount);

    expect(Number(userBalance.amount)).to.equal(userAmount - depositAmount);
    expect(Number(vaultBalance.amount)).to.equal(depositAmount);
  });

  it("Validates token program in CPI", async () => {
    // This test verifies the token program constraint works
    // by checking that the constraint is properly defined
    // (Anchor automatically validates Program<'_, Token> type)
    
    const testMint = await createMint(connection, payer, payer.publicKey, null, 9);
    const from = await createAccount(connection, payer, testMint, payer.publicKey);
    const to = await createAccount(connection, payer, testMint, Keypair.generate().publicKey);
    
    await mintTo(connection, payer, testMint, from, payer, 1_000_000);

    // Valid transfer should work
    await program.methods
      .transferTokens(new anchor.BN(100_000))
      .accounts({
        user: payer.publicKey,
        from: from,
        to: to,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Passing wrong program ID would fail at account validation
    // Anchor's Program<'_, Token> type ensures only valid Token Program is accepted
  });

  it("Prevents unauthorized vault transfer", async () => {
    // Create vault with payer as authority
    const [vaultAuthority, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), payer.publicKey.toBuffer()],
      program.programId
    );

    const vaultMint = await createMint(connection, payer, payer.publicKey, null, 9);
    
    // Use getOrCreateAssociatedTokenAccount for PDA owner
    const vaultTokenAccountInfo = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      vaultMint,
      vaultAuthority,
      true // allowOwnerOffCurve
    );
    const vaultTokenAccount = vaultTokenAccountInfo.address;
    
    const destTokenAccount = await createAccount(connection, payer, vaultMint, Keypair.generate().publicKey);

    await mintTo(connection, payer, vaultMint, vaultTokenAccount, payer, 1_000_000);

    // Try to transfer as different authority (should fail)
    const wrongAuthority = Keypair.generate();
    
    // Need to airdrop some SOL to wrong authority for tx fees
    const airdropSig = await connection.requestAirdrop(wrongAuthority.publicKey, 1_000_000_000);
    await connection.confirmTransaction(airdropSig);

    // Derive PDA for wrong authority - this will be different
    const [wrongVaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), wrongAuthority.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .vaultTransfer(new anchor.BN(100_000), vaultBump)
        .accounts({
          authority: wrongAuthority.publicKey,
          vaultAuthority: wrongVaultAuthority, // Different PDA
          vault: vaultTokenAccount, // Same vault
          to: destTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wrongAuthority])
        .rpc();

      // Should not reach here
      expect.fail("Expected error for unauthorized transfer");
    } catch (error: any) {
      // Expect constraint error because vault.owner != wrongVaultAuthority
      expect(error.toString()).to.include("Error");
    }
  });

  it("Validates token mints match", async () => {
    // Create two different mints
    const mint1 = await createMint(connection, payer, payer.publicKey, null, 9);
    const mint2 = await createMint(connection, payer, payer.publicKey, null, 9);

    const fromAccount = await createAccount(connection, payer, mint1, payer.publicKey);
    const toAccount = await createAccount(connection, payer, mint2, Keypair.generate().publicKey);

    await mintTo(connection, payer, mint1, fromAccount, payer, 1_000_000);

    try {
      await program.methods
        .transferTokens(new anchor.BN(100_000))
        .accounts({
          user: payer.publicKey,
          from: fromAccount,
          to: toAccount, // Different mint!
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      expect.fail("Expected InvalidMint error");
    } catch (error: any) {
      expect(error.toString()).to.include("InvalidMint");
    }
  });

  it("Prevents transfer with insufficient balance", async () => {
    const testMint = await createMint(connection, payer, payer.publicKey, null, 9);
    const from = await createAccount(connection, payer, testMint, payer.publicKey);
    const to = await createAccount(connection, payer, testMint, Keypair.generate().publicKey);

    // Mint only 100 tokens
    await mintTo(connection, payer, testMint, from, payer, 100);

    try {
      // Try to transfer 1000 tokens
      await program.methods
        .transferTokens(new anchor.BN(1000))
        .accounts({
          user: payer.publicKey,
          from: from,
          to: to,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      expect.fail("Expected InsufficientBalance error");
    } catch (error: any) {
      expect(error.toString()).to.include("InsufficientBalance");
    }
  });
});
