use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
    },
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{constants::*, error::PluribusError, events::*, math::to_u64, orca::read_position, risk::book_premium, state::*, token::push};

/// First 8 bytes of sha256("global:update_fees_and_rewards")
const UPDATE_FEES_AND_REWARDS: [u8; 8] = [0x9a, 0xe6, 0xfa, 0x0d, 0xec, 0xd1, 0x4b, 0xdf];
/// First 8 bytes of sha256("global:collect_fees")
const COLLECT_FEES: [u8; 8] = [0xa4, 0x98, 0xcf, 0x63, 0x1e, 0xba, 0x13, 0xb6];

#[derive(Accounts)]
pub struct Autopay<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [LP_MARKET_SEED, whirlpool.key().as_ref()], bump = lp_market.bump)]
    pub lp_market: Box<Account<'info, LpMarket>>,
    /// CHECK: The market seeds above pin this to a whitelisted Whirlpool
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: Owner program, discriminator, mint and pool are checked in the handler
    #[account(mut, seeds = [b"position", position_mint.key().as_ref()], seeds::program = WHIRLPOOL_PROGRAM_ID, bump)]
    pub position: UncheckedAccount<'info>,
    pub position_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = position_mint, token::authority = pool)]
    pub vault_nft: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: The Whirlpool program checks the tick arrays against the position
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: The Whirlpool program checks the tick arrays against the position
    pub tick_array_upper: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_SEED, lp_market.base_mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Box<Account<'info, Asset>>,
    #[account(mut, address = base_asset.vault)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: The Whirlpool program checks this is the pool's own token A vault
    #[account(mut)]
    pub whirlpool_vault_a: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_SEED, usdc_mint.key().as_ref()], bump = usdc_asset.bump)]
    pub usdc_asset: Box<Account<'info, Asset>>,
    #[account(mut, address = usdc_asset.vault)]
    pub usdc_collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: The Whirlpool program checks this is the pool's own token B vault
    #[account(mut)]
    pub whirlpool_vault_b: UncheckedAccount<'info>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Pinned to the Whirlpool program id
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

/// Permissionless: collects a deposited position's trading fees from Orca
/// The USDC part repays debt and the rest stays in the account as collateral
pub fn handle_autopay(ctx: Context<Autopay>) -> Result<()> {
    let a = ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    a.pool.accrue(now)?;
    book_premium(&mut a.pool, &mut a.credit, now)?;
    let mint = a.position_mint.key();
    a.credit.find(KIND_LP, &mint)?;
    // Fees are collected through Orca with the base token in vault A, and Raydium markets have autopay_raydium
    require!(a.lp_market.dex_program == WHIRLPOOL_PROGRAM_ID && a.lp_market.base_first, PluribusError::UnsupportedDex);
    let orca = read_position(&a.position)?;
    require_keys_eq!(orca.position_mint, mint, PluribusError::AccountMismatch);
    require_keys_eq!(orca.whirlpool, a.whirlpool.key(), PluribusError::PoolNotWhitelisted);

    // Fees only show up as owed after the position is synced with the pool
    let update = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(a.whirlpool.key(), false),
            AccountMeta::new(a.position.key(), false),
            AccountMeta::new_readonly(a.tick_array_lower.key(), false),
            AccountMeta::new_readonly(a.tick_array_upper.key(), false),
        ],
        data: UPDATE_FEES_AND_REWARDS.to_vec(),
    };
    invoke(
        &update,
        &[
            a.whirlpool.to_account_info(),
            a.position.to_account_info(),
            a.tick_array_lower.to_account_info(),
            a.tick_array_upper.to_account_info(),
        ],
    )?;

    // The pool PDA holds the NFT, so it signs as the position authority and fees land in our own vaults
    let before = (a.base_vault.amount, a.usdc_collateral_vault.amount);
    let collect = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(a.whirlpool.key(), false),
            AccountMeta::new_readonly(a.pool.key(), true),
            AccountMeta::new(a.position.key(), false),
            AccountMeta::new_readonly(a.vault_nft.key(), false),
            AccountMeta::new(a.base_vault.key(), false),
            AccountMeta::new(a.whirlpool_vault_a.key(), false),
            AccountMeta::new(a.usdc_collateral_vault.key(), false),
            AccountMeta::new(a.whirlpool_vault_b.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
        ],
        data: COLLECT_FEES.to_vec(),
    };
    let seeds = a.pool.signer_seeds();
    invoke_signed(
        &collect,
        &[
            a.whirlpool.to_account_info(),
            a.pool.to_account_info(),
            a.position.to_account_info(),
            a.vault_nft.to_account_info(),
            a.base_vault.to_account_info(),
            a.whirlpool_vault_a.to_account_info(),
            a.usdc_collateral_vault.to_account_info(),
            a.whirlpool_vault_b.to_account_info(),
            a.token_program.to_account_info(),
        ],
        &[&seeds],
    )?;

    Harvest {
        caller: a.caller.key(),
        pool: &mut a.pool,
        credit: &mut a.credit,
        base_asset: &mut a.base_asset,
        base_vault: &mut a.base_vault,
        usdc_asset: &mut a.usdc_asset,
        usdc_collateral_vault: &mut a.usdc_collateral_vault,
        usdc_mint: &a.usdc_mint,
        usdc_vault: &a.usdc_vault,
        token_program: &a.token_program,
    }
    .book(before)
}

/// The accounts a harvest pays into, the same whichever dex the fees came from
pub(crate) struct Harvest<'a, 'info> {
    pub caller: Pubkey,
    pub pool: &'a mut Account<'info, Pool>,
    pub credit: &'a mut Account<'info, CreditAccount>,
    pub base_asset: &'a mut Account<'info, Asset>,
    pub base_vault: &'a mut InterfaceAccount<'info, TokenAccount>,
    pub usdc_asset: &'a mut Account<'info, Asset>,
    pub usdc_collateral_vault: &'a mut InterfaceAccount<'info, TokenAccount>,
    pub usdc_mint: &'a InterfaceAccount<'info, Mint>,
    pub usdc_vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub token_program: &'a Interface<'info, TokenInterface>,
}

impl Harvest<'_, '_> {
    /// Books the fees a collect delivered into the collateral vaults, given their balances (base, USDC) before it
    /// The USDC part repays debt and the rest stays in the account as collateral
    pub fn book(self, before: (u64, u64)) -> Result<()> {
        // What arrived is measured from the vault balances, not taken from the dex's word
        self.base_vault.reload()?;
        self.usdc_collateral_vault.reload()?;
        let base_fee = self.base_vault.amount.saturating_sub(before.0);
        let usdc_fee = self.usdc_collateral_vault.amount.saturating_sub(before.1);

        if base_fee > 0 {
            let base_mint = self.base_asset.mint;
            self.credit.add_token(&base_mint, base_fee)?;
            self.base_asset.total_deposited = self.base_asset.total_deposited.saturating_add(base_fee);
            emit!(CollateralChanged { account: self.credit.key(), mint: base_mint, kind: KIND_TOKEN, amount: base_fee, deposit: true });
        }

        let owed = to_u64((usdc_fee as u128).min(self.pool.debt_of(self.credit)?))?;
        // An amount too small to retire a debt share is kept as collateral instead
        let paid = if owed > 0 && self.pool.retires_debt(self.credit, owed)? { self.pool.repay(self.credit, owed)? } else { 0 };
        if paid > 0 {
            push(self.token_program, self.usdc_mint, self.usdc_collateral_vault, self.usdc_vault, self.pool, paid)?;
            emit!(Repaid {
                account: self.credit.key(),
                payer: self.caller,
                amount: paid,
                debt: to_u64(self.pool.debt_of(self.credit)?)?,
                source: 1,
            });
        }
        let kept = usdc_fee - paid;
        if kept > 0 {
            let usdc = self.usdc_mint.key();
            self.credit.add_token(&usdc, kept)?;
            self.usdc_asset.total_deposited = self.usdc_asset.total_deposited.saturating_add(kept);
            emit!(CollateralChanged { account: self.credit.key(), mint: usdc, kind: KIND_TOKEN, amount: kept, deposit: true });
        }
        Ok(())
    }
}
