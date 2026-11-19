use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::autopay::{collect_orca_fees, OrcaCollect};
use crate::{
    constants::*,
    error::PluribusError,
    events::*,
    instructions::admin::AdminPool,
    math::*,
    oracle::read_mid,
    orca::{read_position, read_sqrt_price},
    state::*,
    token::push,
};

/// First 8 bytes of sha256("global:increase_liquidity")
const INCREASE_LIQUIDITY: [u8; 8] = [0x2e, 0x9c, 0xf3, 0x76, 0x0d, 0xcd, 0xfb, 0xb2];

#[derive(Accounts)]
pub struct SetCompound<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, owner.key().as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
}

/// Lets anyone compound a held position's fees back into it, but only while the pool's price is within `slippage_bps`
/// of the oracle's; 0 has its fees repay debt through autopay instead
/// Only the owner decides, since a looser setting lets a caller who moves the pool first take more of the position's fees
pub fn handle_set_compound(ctx: Context<SetCompound>, position: Pubkey, slippage_bps: u16) -> Result<()> {
    require!(slippage_bps <= MAX_COMPOUND_SLIPPAGE_BPS, PluribusError::InvalidParams);
    let credit = &mut ctx.accounts.credit;
    let slot = credit.lp_slot(&position)?;
    credit.compound_slippage_bps[slot] = slippage_bps;
    emit!(CompoundSet { account: credit.key(), position, slippage_bps });
    Ok(())
}

/// The share of a position's fees paid to whoever compounds it
/// It only ever comes out of fees, which never counted as collateral, so it cannot lower anyone's health, and the hard cap
/// bounds what borrowers who opt in can be charged
pub fn handle_set_compound_bounty(ctx: Context<AdminPool>, bounty_bps: u16) -> Result<()> {
    require!(bounty_bps <= MAX_COMPOUND_BOUNTY_BPS, PluribusError::InvalidParams);
    let pool = &mut ctx.accounts.pool;
    pool.compound_bounty_bps = bounty_bps;
    emit!(ChangeApplied { target: pool.key() });
    Ok(())
}

/// What a collect brought in and what the caller was paid out of it, base token and USDC
pub(crate) struct Fees {
    pub base: u64,
    pub usdc: u64,
    pub bounty_base: u64,
    pub bounty_usdc: u64,
}

impl Fees {
    /// What is left to put back into the position
    pub fn left(&self) -> (u64, u64) {
        (self.base - self.bounty_base, self.usdc - self.bounty_usdc)
    }
}

/// The accounts a compound pays out of and books into, the same whichever dex the position is on
pub(crate) struct Compounder<'a, 'info> {
    pub pool: &'a Account<'info, Pool>,
    pub credit: &'a mut Account<'info, CreditAccount>,
    pub base_asset: &'a mut Account<'info, Asset>,
    pub base_mint: &'a InterfaceAccount<'info, Mint>,
    pub base_vault: &'a mut InterfaceAccount<'info, TokenAccount>,
    pub usdc_asset: &'a mut Account<'info, Asset>,
    pub usdc_mint: &'a InterfaceAccount<'info, Mint>,
    pub usdc_collateral_vault: &'a mut InterfaceAccount<'info, TokenAccount>,
    pub bounty_base: &'a InterfaceAccount<'info, TokenAccount>,
    pub bounty_usdc: &'a InterfaceAccount<'info, TokenAccount>,
    /// USDC's token program
    pub token_program: &'a Interface<'info, TokenInterface>,
    /// The base token's, which differs from USDC's for a token the dex trades through Token-2022
    pub base_token_program: &'a Interface<'info, TokenInterface>,
}

impl Compounder<'_, '_> {
    /// Measures the fees a collect delivered into the collateral vaults since `before` (base, USDC) and pays the caller's
    /// recipient its share of each
    pub fn take_bounty(self, before: (u64, u64)) -> Result<Fees> {
        self.base_vault.reload()?;
        self.usdc_collateral_vault.reload()?;
        let base = self.base_vault.amount.saturating_sub(before.0);
        let usdc = self.usdc_collateral_vault.amount.saturating_sub(before.1);
        let share = self.pool.compound_bounty_bps as u128;
        let bounty_base = to_u64(mul_div_floor(base as u128, share, BPS)?)?;
        let bounty_usdc = to_u64(mul_div_floor(usdc as u128, share, BPS)?)?;
        if bounty_base > 0 {
            push(self.base_token_program, self.base_mint, self.base_vault, self.bounty_base, self.pool, bounty_base)?;
        }
        if bounty_usdc > 0 {
            push(self.token_program, self.usdc_mint, self.usdc_collateral_vault, self.bounty_usdc, self.pool, bounty_usdc)?;
        }
        Ok(Fees { base, usdc, bounty_base, bounty_usdc })
    }

    /// After the add: books whatever fees the position's range could not take as the account's collateral, the same as
    /// autopay does, and refuses if the dex took more than the fees, which would be other depositors' tokens
    pub fn finish(self, before: (u64, u64), fees: Fees, position: Pubkey) -> Result<()> {
        self.base_vault.reload()?;
        self.usdc_collateral_vault.reload()?;
        require!(
            self.base_vault.amount >= before.0 && self.usdc_collateral_vault.amount >= before.1,
            PluribusError::CompoundOverdrawn
        );
        let kept = (self.base_vault.amount - before.0, self.usdc_collateral_vault.amount - before.1);
        let account = self.credit.key();
        for (amount, asset) in [(kept.0, &mut *self.base_asset), (kept.1, &mut *self.usdc_asset)] {
            if amount > 0 {
                let mint = asset.mint;
                self.credit.add_token(&mint, amount)?;
                asset.total_deposited = asset.total_deposited.saturating_add(amount);
                emit!(CollateralChanged { account, mint, kind: KIND_TOKEN, amount, deposit: true });
            }
        }
        let left = fees.left();
        emit!(Compounded {
            account,
            position,
            recipient: self.bounty_usdc.owner,
            fee_base: fees.base,
            fee_usdc: fees.usdc,
            bounty_base: fees.bounty_base,
            bounty_usdc: fees.bounty_usdc,
            added_base: left.0 - kept.0.min(left.0),
            added_usdc: left.1 - kept.1.min(left.1),
        });
        Ok(())
    }
}

/// The position's own setting, which must be on, and whether the pool's price sits close enough to the oracle's for it
/// Adding liquidity is priced at the pool's own price, which a caller can push around inside its transaction,
/// so the oracle is the yardstick and the owner sets how far off it may be
pub(crate) fn require_fair_price(
    pool: &Pool,
    credit: &CreditAccount,
    position: &Pubkey,
    base_asset: &Asset,
    base_price: &AccountInfo,
    pool_sqrt: u128,
    base_first: bool,
) -> Result<()> {
    let tolerance = credit.compound_slippage_bps[credit.lp_slot(position)?];
    require!(tolerance > 0, PluribusError::CompoundOff);
    let mid = read_mid(pool, base_asset, base_price, Clock::get()?.unix_timestamp)?;
    let oracle_sqrt = sqrt_price_x64(mid, base_asset.price_decimals())?;
    // With USDC first the pool quotes the base token upside down, whose sqrt price is the inverse in Q64.64
    let reference = if base_first { oracle_sqrt } else { (u128::MAX / oracle_sqrt).max(1) };
    require!(sqrt_prices_within(pool_sqrt, reference, tolerance)?, PluribusError::PoolPriceOff);
    Ok(())
}

#[derive(Accounts)]
pub struct CompoundOrca<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint)]
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
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: The Whirlpool program checks the tick arrays against the position
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_SEED, lp_market.base_mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Box<Account<'info, Asset>>,
    #[account(address = base_asset.mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = base_asset.vault)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: The base token's price account, checked against the asset's feed or mint when read
    pub base_price: UncheckedAccount<'info>,
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
    /// The caller's bounty in the base token, to any account it names, never one of the protocol's vaults
    #[account(mut, token::mint = base_mint, constraint = bounty_base.key() != base_vault.key() @ PluribusError::AccountMismatch)]
    pub bounty_base: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The caller's bounty in USDC
    #[account(mut, token::mint = usdc_mint, constraint = bounty_usdc.key() != usdc_collateral_vault.key() @ PluribusError::AccountMismatch)]
    pub bounty_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Pinned to the Whirlpool program id
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

/// Permissionless: collects a held Orca position's fees, pays the caller's recipient its share, and adds the rest back into
/// the position at the pool's price, which must sit within the owner's tolerance of the oracle's
/// Whatever the range cannot take stays in the account as collateral; no health check is needed, since fees never counted
pub fn handle_compound_orca(ctx: Context<CompoundOrca>) -> Result<()> {
    let a = ctx.accounts;
    let mint = a.position_mint.key();
    // Fees are collected with the base token in vault A, as for autopay
    require!(a.lp_market.dex_program == WHIRLPOOL_PROGRAM_ID && a.lp_market.base_first, PluribusError::UnsupportedDex);
    a.credit.find(KIND_LP, &mint)?;
    let orca = read_position(&a.position)?;
    require_keys_eq!(orca.position_mint, mint, PluribusError::AccountMismatch);
    require_keys_eq!(orca.whirlpool, a.whirlpool.key(), PluribusError::PoolNotWhitelisted);
    let sqrt_price = read_sqrt_price(&a.whirlpool)?;
    require_fair_price(&a.pool, &a.credit, &mint, &a.base_asset, &a.base_price, sqrt_price, true)?;

    let before = (a.base_vault.amount, a.usdc_collateral_vault.amount);
    collect_orca_fees(
        OrcaCollect {
            whirlpool: a.whirlpool.to_account_info(),
            position: a.position.to_account_info(),
            tick_array_lower: a.tick_array_lower.to_account_info(),
            tick_array_upper: a.tick_array_upper.to_account_info(),
            vault_nft: a.vault_nft.to_account_info(),
            base_vault: a.base_vault.to_account_info(),
            whirlpool_vault_a: a.whirlpool_vault_a.to_account_info(),
            usdc_vault: a.usdc_collateral_vault.to_account_info(),
            whirlpool_vault_b: a.whirlpool_vault_b.to_account_info(),
            token_program: a.token_program.to_account_info(),
        },
        &a.pool,
    )?;
    let fees = Compounder {
        pool: &a.pool,
        credit: &mut a.credit,
        base_asset: &mut a.base_asset,
        base_mint: &a.base_mint,
        base_vault: &mut a.base_vault,
        usdc_asset: &mut a.usdc_asset,
        usdc_mint: &a.usdc_mint,
        usdc_collateral_vault: &mut a.usdc_collateral_vault,
        bounty_base: &a.bounty_base,
        bounty_usdc: &a.bounty_usdc,
        token_program: &a.token_program,
        base_token_program: &a.token_program,
    }
    .take_bounty(before)?;

    let (left_base, left_usdc) = fees.left();
    let (liquidity, _, _) = liquidity_for_amounts(sqrt_price, orca.tick_lower, orca.tick_upper, left_base, left_usdc)?;
    if liquidity > 0 {
        // The pool PDA owns the NFT and both vaults, so it signs as the position authority and the tokens' owner
        let data = [&INCREASE_LIQUIDITY[..], &liquidity.to_le_bytes(), &left_base.to_le_bytes(), &left_usdc.to_le_bytes()].concat();
        let increase = Instruction {
            program_id: WHIRLPOOL_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(a.whirlpool.key(), false),
                AccountMeta::new_readonly(a.token_program.key(), false),
                AccountMeta::new_readonly(a.pool.key(), true),
                AccountMeta::new(a.position.key(), false),
                AccountMeta::new_readonly(a.vault_nft.key(), false),
                AccountMeta::new(a.base_vault.key(), false),
                AccountMeta::new(a.usdc_collateral_vault.key(), false),
                AccountMeta::new(a.whirlpool_vault_a.key(), false),
                AccountMeta::new(a.whirlpool_vault_b.key(), false),
                AccountMeta::new(a.tick_array_lower.key(), false),
                AccountMeta::new(a.tick_array_upper.key(), false),
            ],
            data,
        };
        let seeds = a.pool.signer_seeds();
        invoke_signed(
            &increase,
            &[
                a.whirlpool.to_account_info(),
                a.token_program.to_account_info(),
                a.pool.to_account_info(),
                a.position.to_account_info(),
                a.vault_nft.to_account_info(),
                a.base_vault.to_account_info(),
                a.usdc_collateral_vault.to_account_info(),
                a.whirlpool_vault_a.to_account_info(),
                a.whirlpool_vault_b.to_account_info(),
                a.tick_array_lower.to_account_info(),
                a.tick_array_upper.to_account_info(),
            ],
            &[&seeds],
        )?;
    }

    Compounder {
        pool: &a.pool,
        credit: &mut a.credit,
        base_asset: &mut a.base_asset,
        base_mint: &a.base_mint,
        base_vault: &mut a.base_vault,
        usdc_asset: &mut a.usdc_asset,
        usdc_mint: &a.usdc_mint,
        usdc_collateral_vault: &mut a.usdc_collateral_vault,
        bounty_base: &a.bounty_base,
        bounty_usdc: &a.bounty_usdc,
        token_program: &a.token_program,
        base_token_program: &a.token_program,
    }
    .finish(before, fees, mint)
}
