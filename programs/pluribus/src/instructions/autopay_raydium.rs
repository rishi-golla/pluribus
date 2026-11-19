use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::{
    token::ID as TOKEN_PROGRAM_ID,
    token_interface::{Mint, Token2022, TokenAccount, TokenInterface},
};

use super::autopay::Harvest;
use crate::{clmm::read_position, constants::*, error::PluribusError, state::*};

/// First 8 bytes of sha256("global:decrease_liquidity_v2")
const DECREASE_LIQUIDITY_V2: [u8; 8] = [0x3a, 0x7f, 0xbc, 0x3e, 0x4f, 0x52, 0xc4, 0x60];

#[derive(Accounts)]
pub struct AutopayRaydium<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        seeds = [LP_MARKET_SEED, clmm_pool.key().as_ref()],
        bump = lp_market.bump,
        constraint = RAYDIUM_CLMM_PROGRAMS.contains(&lp_market.dex_program) @ PluribusError::NotRaydiumMarket,
    )]
    pub lp_market: Box<Account<'info, LpMarket>>,
    /// CHECK: The market seeds above pin this to a whitelisted Raydium pool
    #[account(mut)]
    pub clmm_pool: UncheckedAccount<'info>,
    /// CHECK: Owner program, discriminator, mint and pool are checked in the handler
    #[account(mut, seeds = [b"position", position_mint.key().as_ref()], seeds::program = lp_market.dex_program, bump)]
    pub position: UncheckedAccount<'info>,
    pub position_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = position_mint, token::authority = pool)]
    pub vault_nft: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Raydium's own PDA for the position's range, which newer versions no longer read
    #[account(mut)]
    pub protocol_position: UncheckedAccount<'info>,
    /// CHECK: Raydium checks this is the pool's own token 0 vault
    #[account(mut)]
    pub clmm_vault_0: UncheckedAccount<'info>,
    /// CHECK: Raydium checks this is the pool's own token 1 vault
    #[account(mut)]
    pub clmm_vault_1: UncheckedAccount<'info>,
    /// CHECK: Raydium checks the tick arrays against the position and the pool
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: Raydium checks the tick arrays against the position and the pool
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_SEED, lp_market.base_mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Box<Account<'info, Asset>>,
    #[account(address = base_asset.mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = base_asset.vault)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [ASSET_SEED, usdc_mint.key().as_ref()], bump = usdc_asset.bump)]
    pub usdc_asset: Box<Account<'info, Asset>>,
    #[account(mut, address = usdc_asset.vault)]
    pub usdc_collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// USDC is a classic token, and Raydium takes the classic program in this slot whatever the pool trades
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub token_program_2022: Program<'info, Token2022>,
    /// CHECK: Pinned to the memo program
    #[account(address = MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: Pinned to the market's Raydium program
    #[account(address = lp_market.dex_program)]
    pub dex_program: UncheckedAccount<'info>,
}

/// Permissionless: collects a deposited position's trading fees from Raydium
/// The USDC part repays debt and the rest stays in the account as collateral
/// Remaining accounts are what Raydium wants besides the fees, as it takes them: the tick array bitmap extension when
/// the position needs it, and a group of reward vault, recipient and reward mint for each reward the pool runs
pub fn handle_autopay_raydium<'info>(ctx: Context<'info, AutopayRaydium<'info>>) -> Result<()> {
    let rem = ctx.remaining_accounts;
    let a = ctx.accounts;
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    let mint = a.position_mint.key();
    a.credit.find(KIND_LP, &mint)?;
    let position = read_position(&a.lp_market, &a.position)?;
    require_keys_eq!(position.mint, mint, PluribusError::AccountMismatch);

    // A reward the position has earned is paid out in the same call, so it can only go to the account's owner
    let extension = Pubkey::find_program_address(&[b"pool_tick_array_bitmap_extension", a.clmm_pool.key().as_ref()], &a.dex_program.key()).0;
    let rewards: Vec<&AccountInfo> = rem.iter().filter(|r| *r.key != extension).collect();
    require!(rewards.len() % 3 == 0, PluribusError::AccountMismatch);
    for group in rewards.chunks(3) {
        let recipient = InterfaceAccount::<TokenAccount>::try_from(group[1])?;
        require_keys_eq!(recipient.owner, a.credit.owner, PluribusError::AccountMismatch);
    }

    // Raydium has no fee collection of its own: taking out no liquidity pays out what the position has earned
    // Its tokens come in the pool's own order, so base and USDC swap places when USDC is token 0
    let base_first = a.lp_market.base_first;
    let (recipient_0, recipient_1) =
        if base_first { (&a.base_vault, &a.usdc_collateral_vault) } else { (&a.usdc_collateral_vault, &a.base_vault) };
    let (mint_0, mint_1) = if base_first { (a.base_mint.key(), a.usdc_mint.key()) } else { (a.usdc_mint.key(), a.base_mint.key()) };
    let mut accounts = vec![
        // The pool PDA holds the NFT, so it signs as the position owner and fees land in our own vaults
        AccountMeta::new_readonly(a.pool.key(), true),
        AccountMeta::new_readonly(a.vault_nft.key(), false),
        AccountMeta::new(a.position.key(), false),
        AccountMeta::new(a.clmm_pool.key(), false),
        AccountMeta::new(a.protocol_position.key(), false),
        AccountMeta::new(a.clmm_vault_0.key(), false),
        AccountMeta::new(a.clmm_vault_1.key(), false),
        AccountMeta::new(a.tick_array_lower.key(), false),
        AccountMeta::new(a.tick_array_upper.key(), false),
        AccountMeta::new(recipient_0.key(), false),
        AccountMeta::new(recipient_1.key(), false),
        AccountMeta::new_readonly(a.token_program.key(), false),
        AccountMeta::new_readonly(a.token_program_2022.key(), false),
        AccountMeta::new_readonly(a.memo_program.key(), false),
        AccountMeta::new_readonly(mint_0, false),
        AccountMeta::new_readonly(mint_1, false),
    ];
    let mut infos = vec![
        a.pool.to_account_info(),
        a.vault_nft.to_account_info(),
        a.position.to_account_info(),
        a.clmm_pool.to_account_info(),
        a.protocol_position.to_account_info(),
        a.clmm_vault_0.to_account_info(),
        a.clmm_vault_1.to_account_info(),
        a.tick_array_lower.to_account_info(),
        a.tick_array_upper.to_account_info(),
        recipient_0.to_account_info(),
        recipient_1.to_account_info(),
        a.token_program.to_account_info(),
        a.token_program_2022.to_account_info(),
        a.memo_program.to_account_info(),
        if base_first { a.base_mint.to_account_info() } else { a.usdc_mint.to_account_info() },
        if base_first { a.usdc_mint.to_account_info() } else { a.base_mint.to_account_info() },
        a.dex_program.to_account_info(),
    ];
    for r in rem {
        accounts.push(AccountMeta { pubkey: r.key(), is_signer: false, is_writable: r.is_writable });
        infos.push(r.clone());
    }
    // liquidity, amount 0 min and amount 1 min, all zero
    let mut data = DECREASE_LIQUIDITY_V2.to_vec();
    data.extend_from_slice(&[0u8; 32]);

    let before = (a.base_vault.amount, a.usdc_collateral_vault.amount);
    let seeds = a.pool.signer_seeds();
    invoke_signed(&Instruction { program_id: a.lp_market.dex_program, accounts, data }, &infos, &[&seeds])?;

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
