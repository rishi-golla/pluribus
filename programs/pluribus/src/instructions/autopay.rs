use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
    },
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::compound::Compounder;
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
    #[account(address = base_asset.mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
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
    /// The caller's bounty in the base token, to any account it names, never one of the protocol's vaults
    #[account(mut, token::mint = base_mint, constraint = bounty_base.key() != base_vault.key() @ PluribusError::AccountMismatch)]
    pub bounty_base: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The caller's bounty in USDC
    #[account(
        mut,
        token::mint = usdc_mint,
        constraint = bounty_usdc.key() != usdc_collateral_vault.key() && bounty_usdc.key() != usdc_vault.key() @ PluribusError::AccountMismatch,
    )]
    pub bounty_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Pinned to the Whirlpool program id
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

/// Permissionless: collects a deposited position's trading fees from Orca and pays the caller's recipient the pool's bounty
/// share of them; the USDC left repays debt and the rest stays in the account as collateral
pub fn handle_autopay(ctx: Context<Autopay>) -> Result<()> {
    let a = ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    a.pool.accrue(now)?;
    book_premium(&mut a.pool, &mut a.credit, now)?;
    let mint = a.position_mint.key();
    let slot = a.credit.find(KIND_LP, &mint)?;
    // A position set to compound keeps its fees for that, which only its owner can switch off
    require!(a.credit.compound_slippage_bps[slot] == 0, PluribusError::CompoundOn);
    // Fees are collected through Orca with the base token in vault A, and Raydium markets have autopay_raydium
    require!(a.lp_market.dex_program == WHIRLPOOL_PROGRAM_ID && a.lp_market.base_first, PluribusError::UnsupportedDex);
    let orca = read_position(&a.position)?;
    require_keys_eq!(orca.position_mint, mint, PluribusError::AccountMismatch);
    require_keys_eq!(orca.whirlpool, a.whirlpool.key(), PluribusError::PoolNotWhitelisted);

    let before = (a.base_vault.amount, a.usdc_collateral_vault.amount);
    collect_orca_fees(OrcaCollect {
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
    }, &a.pool)?;

    Harvest {
        caller: a.caller.key(),
        position: mint,
        pool: &mut a.pool,
        credit: &mut a.credit,
        base_asset: &mut a.base_asset,
        base_mint: &a.base_mint,
        base_vault: &mut a.base_vault,
        usdc_asset: &mut a.usdc_asset,
        usdc_collateral_vault: &mut a.usdc_collateral_vault,
        usdc_mint: &a.usdc_mint,
        usdc_vault: &a.usdc_vault,
        bounty_base: &a.bounty_base,
        bounty_usdc: &a.bounty_usdc,
        token_program: &a.token_program,
        // Orca collects both of a listed pool's tokens through the one program
        base_token_program: &a.token_program,
    }
    .book(before)
}

/// The accounts an Orca fee collect touches, with the base token in vault A and USDC in vault B
pub(crate) struct OrcaCollect<'info> {
    pub whirlpool: AccountInfo<'info>,
    pub position: AccountInfo<'info>,
    pub tick_array_lower: AccountInfo<'info>,
    pub tick_array_upper: AccountInfo<'info>,
    pub vault_nft: AccountInfo<'info>,
    pub base_vault: AccountInfo<'info>,
    pub whirlpool_vault_a: AccountInfo<'info>,
    pub usdc_vault: AccountInfo<'info>,
    pub whirlpool_vault_b: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

/// Syncs a held Orca position with its pool and collects its fees into our own vaults
/// The pool PDA holds the NFT, so it signs as the position authority
pub(crate) fn collect_orca_fees<'info>(c: OrcaCollect<'info>, pool: &Account<'info, Pool>) -> Result<()> {
    // Fees only show up as owed after the position is synced with the pool
    let update = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(c.whirlpool.key(), false),
            AccountMeta::new(c.position.key(), false),
            AccountMeta::new_readonly(c.tick_array_lower.key(), false),
            AccountMeta::new_readonly(c.tick_array_upper.key(), false),
        ],
        data: UPDATE_FEES_AND_REWARDS.to_vec(),
    };
    invoke(&update, &[c.whirlpool.clone(), c.position.clone(), c.tick_array_lower.clone(), c.tick_array_upper.clone()])?;
    let collect = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(c.whirlpool.key(), false),
            AccountMeta::new_readonly(pool.key(), true),
            AccountMeta::new(c.position.key(), false),
            AccountMeta::new_readonly(c.vault_nft.key(), false),
            AccountMeta::new(c.base_vault.key(), false),
            AccountMeta::new(c.whirlpool_vault_a.key(), false),
            AccountMeta::new(c.usdc_vault.key(), false),
            AccountMeta::new(c.whirlpool_vault_b.key(), false),
            AccountMeta::new_readonly(c.token_program.key(), false),
        ],
        data: COLLECT_FEES.to_vec(),
    };
    let seeds = pool.signer_seeds();
    invoke_signed(
        &collect,
        &[c.whirlpool, pool.to_account_info(), c.position, c.vault_nft, c.base_vault, c.whirlpool_vault_a, c.usdc_vault, c.whirlpool_vault_b, c.token_program],
        &[&seeds],
    )?;
    Ok(())
}

/// The accounts a harvest pays out of and into, the same whichever dex the fees came from
pub(crate) struct Harvest<'a, 'info> {
    pub caller: Pubkey,
    /// The position's NFT mint, or the Meteora position's own address
    pub position: Pubkey,
    pub pool: &'a mut Account<'info, Pool>,
    pub credit: &'a mut Account<'info, CreditAccount>,
    pub base_asset: &'a mut Account<'info, Asset>,
    pub base_mint: &'a InterfaceAccount<'info, Mint>,
    pub base_vault: &'a mut InterfaceAccount<'info, TokenAccount>,
    pub usdc_asset: &'a mut Account<'info, Asset>,
    pub usdc_collateral_vault: &'a mut InterfaceAccount<'info, TokenAccount>,
    pub usdc_mint: &'a InterfaceAccount<'info, Mint>,
    pub usdc_vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub bounty_base: &'a InterfaceAccount<'info, TokenAccount>,
    pub bounty_usdc: &'a InterfaceAccount<'info, TokenAccount>,
    /// USDC's token program
    pub token_program: &'a Interface<'info, TokenInterface>,
    /// The base token's, which differs from USDC's for a token the dex trades through Token-2022
    pub base_token_program: &'a Interface<'info, TokenInterface>,
}

impl Harvest<'_, '_> {
    /// Books the fees a collect delivered into the collateral vaults, given their balances (base, USDC) before it
    /// The caller's recipient is paid the same bounty share a compound pays, so nobody has to be paid to run autopay;
    /// the USDC left repays debt and the rest stays in the account as collateral
    pub fn book(self, before: (u64, u64)) -> Result<()> {
        // What arrived is measured from the vault balances, not taken from the dex's word
        let fees = Compounder {
            pool: &*self.pool,
            credit: &mut *self.credit,
            base_asset: &mut *self.base_asset,
            base_mint: self.base_mint,
            base_vault: &mut *self.base_vault,
            usdc_asset: &mut *self.usdc_asset,
            usdc_mint: self.usdc_mint,
            usdc_collateral_vault: &mut *self.usdc_collateral_vault,
            bounty_base: self.bounty_base,
            bounty_usdc: self.bounty_usdc,
            token_program: self.token_program,
            base_token_program: self.base_token_program,
        }
        .take_bounty(before)?;
        let (base_fee, usdc_fee) = fees.left();

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
        emit!(Autopaid {
            account: self.credit.key(),
            position: self.position,
            recipient: self.bounty_usdc.owner,
            fee_base: fees.base,
            fee_usdc: fees.usdc,
            bounty_base: fees.bounty_base,
            bounty_usdc: fees.bounty_usdc,
            repaid: paid,
        });
        Ok(())
    }
}
