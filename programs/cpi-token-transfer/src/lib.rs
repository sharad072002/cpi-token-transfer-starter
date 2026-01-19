use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

// Protocol fee: 1% (100 basis points)
const PROTOCOL_FEE_BPS: u64 = 100;
const BPS_DENOMINATOR: u64 = 10000;

// Seeds for PDAs
const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol_config";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";

#[program]
pub mod cpi_token_transfer {
    use super::*;

    /// Initialize the protocol config with fee recipient
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.protocol_config;
        config.authority = ctx.accounts.authority.key();
        config.fee_recipient = ctx.accounts.fee_recipient.key();
        config.fee_bps = PROTOCOL_FEE_BPS;
        config.bump = ctx.bumps.protocol_config;
        
        msg!("Protocol initialized with fee recipient: {}", config.fee_recipient);
        Ok(())
    }

    /// Simple token transfer via CPI
    /// User signs the transfer, calls Token Program's transfer instruction
    pub fn transfer_tokens(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
        // Validate source has sufficient balance
        require!(
            ctx.accounts.from.amount >= amount,
            CpiError::InsufficientBalance
        );

        // Validate mints match
        require!(
            ctx.accounts.from.mint == ctx.accounts.to.mint,
            CpiError::InvalidMint
        );

        // Build CPI context for token transfer
        let cpi_accounts = Transfer {
            from: ctx.accounts.from.to_account_info(),
            to: ctx.accounts.to.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        // Execute CPI transfer
        token::transfer(cpi_ctx, amount)?;

        msg!("Transferred {} tokens via CPI", amount);
        Ok(())
    }

    /// Transfer with protocol fee (payment splitter)
    /// Calculate fee amount, transfer fee to protocol, transfer remainder to recipient
    pub fn transfer_with_fee(ctx: Context<TransferWithFee>, amount: u64) -> Result<()> {
        // Validate source has sufficient balance
        require!(
            ctx.accounts.from.amount >= amount,
            CpiError::InsufficientBalance
        );

        // Validate all mints match
        let mint = ctx.accounts.from.mint;
        require!(ctx.accounts.to.mint == mint, CpiError::InvalidMint);
        require!(
            ctx.accounts.protocol_fee_account.mint == mint,
            CpiError::InvalidMint
        );

        // Calculate fee using checked arithmetic
        let fee = amount
            .checked_mul(PROTOCOL_FEE_BPS)
            .ok_or(CpiError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(CpiError::Overflow)?;

        let recipient_amount = amount.checked_sub(fee).ok_or(CpiError::Overflow)?;

        // Transfer fee to protocol
        if fee > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.protocol_fee_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
            );
            token::transfer(cpi_ctx, fee)?;
            msg!("Transferred {} tokens as protocol fee", fee);
        }

        // Transfer remainder to recipient
        if recipient_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
            );
            token::transfer(cpi_ctx, recipient_amount)?;
            msg!("Transferred {} tokens to recipient", recipient_amount);
        }

        Ok(())
    }

    /// Deposit tokens into a vault
    /// User transfers tokens to a PDA-owned vault account
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        // Validate source has sufficient balance
        require!(
            ctx.accounts.from.amount >= amount,
            CpiError::InsufficientBalance
        );

        // Validate mints match
        require!(
            ctx.accounts.from.mint == ctx.accounts.vault.mint,
            CpiError::InvalidMint
        );

        // Build CPI context for token transfer to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.from.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        // Execute CPI transfer
        token::transfer(cpi_ctx, amount)?;

        msg!("Deposited {} tokens to vault", amount);
        Ok(())
    }

    /// PDA-signed transfer from vault (withdraw)
    /// Vault is a PDA-owned token account, sign CPI with PDA seeds
    pub fn vault_transfer(
        ctx: Context<VaultTransfer>,
        amount: u64,
        vault_bump: u8,
    ) -> Result<()> {
        // Validate vault has sufficient balance
        require!(
            ctx.accounts.vault.amount >= amount,
            CpiError::InsufficientBalance
        );

        // Validate mints match
        require!(
            ctx.accounts.vault.mint == ctx.accounts.to.mint,
            CpiError::InvalidMint
        );

        // Build PDA signer seeds
        let authority_key = ctx.accounts.authority.key();
        let seeds = &[
            VAULT_AUTHORITY_SEED,
            authority_key.as_ref(),
            &[vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Build CPI context with PDA signer
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.to.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Execute CPI transfer
        token::transfer(cpi_ctx, amount)?;

        msg!("Transferred {} tokens from vault via PDA signature", amount);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// The fee recipient token account owner
    /// CHECK: This is just a pubkey to receive fees, validated by authority
    pub fee_recipient: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    /// User signing the transfer (must be owner/delegate of source account)
    pub user: Signer<'info>,

    /// Source token account (must be owned by user)
    #[account(
        mut,
        constraint = from.owner == user.key() @ CpiError::Unauthorized
    )]
    pub from: Account<'info, TokenAccount>,

    /// Destination token account
    #[account(mut)]
    pub to: Account<'info, TokenAccount>,

    /// Token Program for CPI - explicitly validate program ID
    #[account(address = anchor_spl::token::ID @ CpiError::InvalidProgram)]
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TransferWithFee<'info> {
    /// User signing the transfer
    pub user: Signer<'info>,

    /// Source token account (must be owned by user)
    #[account(
        mut,
        constraint = from.owner == user.key() @ CpiError::Unauthorized
    )]
    pub from: Account<'info, TokenAccount>,

    /// Recipient token account
    #[account(mut)]
    pub to: Account<'info, TokenAccount>,

    /// Protocol fee collection account
    #[account(mut)]
    pub protocol_fee_account: Account<'info, TokenAccount>,

    /// Token Program for CPI - explicitly validate program ID
    #[account(address = anchor_spl::token::ID @ CpiError::InvalidProgram)]
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    /// User depositing tokens
    pub user: Signer<'info>,

    /// Source token account (must be owned by user)
    #[account(
        mut,
        constraint = from.owner == user.key() @ CpiError::Unauthorized
    )]
    pub from: Account<'info, TokenAccount>,

    /// Vault authority PDA
    /// CHECK: This is a PDA used only for vault ownership, validated by seeds
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, user.key().as_ref()],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,

    /// Vault token account owned by the vault authority PDA
    #[account(
        mut,
        constraint = vault.owner == vault_authority.key() @ CpiError::Unauthorized
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Token Program for CPI - explicitly validate program ID
    #[account(address = anchor_spl::token::ID @ CpiError::InvalidProgram)]
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct VaultTransfer<'info> {
    /// Authority that controls the vault
    pub authority: Signer<'info>,

    /// Vault authority PDA - used for signing CPI
    /// Seeds: [VAULT_AUTHORITY_SEED, authority.key()]
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, authority.key().as_ref()],
        bump
    )]
    /// CHECK: This is a PDA used only for signing, validated by seeds
    pub vault_authority: AccountInfo<'info>,

    /// Vault token account owned by the vault authority PDA
    #[account(
        mut,
        constraint = vault.owner == vault_authority.key() @ CpiError::Unauthorized
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Destination token account
    #[account(mut)]
    pub to: Account<'info, TokenAccount>,

    /// Token Program for CPI - explicitly validate program ID
    #[account(address = anchor_spl::token::ID @ CpiError::InvalidProgram)]
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    /// Authority that can update the config
    pub authority: Pubkey,
    /// Fee recipient address
    pub fee_recipient: Pubkey,
    /// Fee in basis points (100 = 1%)
    pub fee_bps: u64,
    /// PDA bump
    pub bump: u8,
}

#[error_code]
pub enum CpiError {
    #[msg("Unauthorized: Invalid authority")]
    Unauthorized,
    #[msg("Invalid token mint")]
    InvalidMint,
    #[msg("Insufficient balance for transfer")]
    InsufficientBalance,
    #[msg("Invalid program for CPI")]
    InvalidProgram,
    #[msg("Arithmetic overflow")]
    Overflow,
}
