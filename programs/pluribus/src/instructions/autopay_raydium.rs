use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::{
    token::ID as TOKEN_PROGRAM_ID,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use super::autopay::Harvest;
use crate::{clmm::read_position, constants::*, error::PluribusError, risk::book_premium, state::*};

/// First 8 bytes of sha256("global:decrease_liquidity_v2")
const DECREASE_LIQUIDITY_V2: [u8; 8] = [0x3a, 0x7f, 0xbc, 0x3e, 0x4f, 0x52, 0xc4, 0x60];
/// First 8 bytes of sha256("global:increase_liquidity_v2")
const INCREASE_LIQUIDITY_V2: [u8; 8] = [0x85, 0x1d, 0x59, 0xdf, 0x45, 0xee, 0xb0, 0x0a];

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
    /// USDC is a classic token, and Raydium takes the classic program in this slot whatever the pool trades
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_program_2022: Interface<'info, TokenInterface>,
    /// CHECK: Pinned to the memo program
    #[account(address = MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: Pinned to the market's Raydium program
    #[account(address = lp_market.dex_program)]
    pub dex_program: UncheckedAccount<'info>,
}

/// Permissionless: collects a deposited position's trading fees from Raydium and pays the caller's recipient the pool's
/// bounty share of them; the USDC left repays debt and the rest stays in the account as collateral
/// Remaining accounts are what Raydium wants besides the fees, as it takes them: the tick array bitmap extension when
/// the position needs it, and a group of reward vault, recipient and reward mint for each reward the pool runs
pub fn handle_autopay_raydium<'info>(ctx: Context<'info, AutopayRaydium<'info>>) -> Result<()> {
    let rem = ctx.remaining_accounts;
    let a = ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    a.pool.accrue(now)?;
    book_premium(&mut a.pool, &mut a.credit, now)?;
    let mint = a.position_mint.key();
    let slot = a.credit.find(KIND_LP, &mint)?;
    // A position set to compound keeps its fees for that, which only its owner can switch off
    require!(a.credit.compound_slippage_bps[slot] == 0, PluribusError::CompoundOn);
    let position = read_position(&a.lp_market, &a.position)?;
    require_keys_eq!(position.mint, mint, PluribusError::AccountMismatch);

    let raydium = RaydiumPosition {
        base_first: a.lp_market.base_first,
        clmm_pool: a.clmm_pool.to_account_info(),
        position: a.position.to_account_info(),
        vault_nft: a.vault_nft.to_account_info(),
        protocol_position: a.protocol_position.to_account_info(),
        clmm_vault_0: a.clmm_vault_0.to_account_info(),
        clmm_vault_1: a.clmm_vault_1.to_account_info(),
        tick_array_lower: a.tick_array_lower.to_account_info(),
        tick_array_upper: a.tick_array_upper.to_account_info(),
        base_vault: a.base_vault.to_account_info(),
        base_mint: a.base_mint.to_account_info(),
        usdc_vault: a.usdc_collateral_vault.to_account_info(),
        usdc_mint: a.usdc_mint.to_account_info(),
        token_program: a.token_program.to_account_info(),
        token_program_2022: a.token_program_2022.to_account_info(),
        memo_program: a.memo_program.to_account_info(),
        dex_program: a.dex_program.to_account_info(),
    };
    let before = (a.base_vault.amount, a.usdc_collateral_vault.amount);
    collect_raydium_fees(&raydium, &a.pool, &a.credit.owner, rem)?;

    // A stock Raydium trades through Token-2022 pays its bounty through that program, and USDC through the classic one
    let base_token_program = if *a.base_mint.to_account_info().owner == anchor_spl::token_2022::ID { &a.token_program_2022 } else { &a.token_program };
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
        base_token_program,
    }
    .book(before)
}

/// A held Raydium position's accounts, as every instruction of Raydium's on it takes them, with our own collateral vaults
/// beside the pool's
pub(crate) struct RaydiumPosition<'info> {
    pub base_first: bool,
    pub clmm_pool: AccountInfo<'info>,
    pub position: AccountInfo<'info>,
    pub vault_nft: AccountInfo<'info>,
    pub protocol_position: AccountInfo<'info>,
    pub clmm_vault_0: AccountInfo<'info>,
    pub clmm_vault_1: AccountInfo<'info>,
    pub tick_array_lower: AccountInfo<'info>,
    pub tick_array_upper: AccountInfo<'info>,
    pub base_vault: AccountInfo<'info>,
    pub base_mint: AccountInfo<'info>,
    pub usdc_vault: AccountInfo<'info>,
    pub usdc_mint: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub token_program_2022: AccountInfo<'info>,
    pub memo_program: AccountInfo<'info>,
    pub dex_program: AccountInfo<'info>,
}

impl<'info> RaydiumPosition<'info> {
    /// Our vault and mint for each of the pool's tokens, in the pool's own order, so base and USDC swap places when USDC is
    /// token 0
    fn pool_order(&self) -> [(&AccountInfo<'info>, &AccountInfo<'info>); 2] {
        let (base, usdc) = ((&self.base_vault, &self.base_mint), (&self.usdc_vault, &self.usdc_mint));
        if self.base_first {
            [base, usdc]
        } else {
            [usdc, base]
        }
    }

    /// Where Raydium keeps the bitmap of the pool's tick arrays that outgrow its own, which a far-out range needs
    fn bitmap_extension(&self) -> Pubkey {
        Pubkey::find_program_address(&[b"pool_tick_array_bitmap_extension", self.clmm_pool.key.as_ref()], self.dex_program.key).0
    }
}

/// Collects a held Raydium position's trading fees into our own collateral vaults, which Raydium has no instruction for:
/// taking out no liquidity pays out what the position has earned
/// `rem` are what Raydium wants besides the fees, as it takes them: the tick array bitmap extension when the position needs
/// it, and a group of reward vault, recipient and reward mint for each reward the pool runs
pub(crate) fn collect_raydium_fees<'info>(
    c: &RaydiumPosition<'info>,
    pool: &Account<'info, Pool>,
    owner: &Pubkey,
    rem: &'info [AccountInfo<'info>],
) -> Result<()> {
    // A reward the position has earned is paid out in the same call, so it can only go to the account's owner
    let rewards: Vec<&AccountInfo> = if rem.is_empty() {
        vec![]
    } else {
        let extension = c.bitmap_extension();
        rem.iter().filter(|r| *r.key != extension).collect()
    };
    require!(rewards.len() % 3 == 0, PluribusError::AccountMismatch);
    for group in rewards.chunks(3) {
        let recipient = InterfaceAccount::<TokenAccount>::try_from(group[1])?;
        require_keys_eq!(recipient.owner, *owner, PluribusError::AccountMismatch);
    }

    let [(recipient_0, mint_0), (recipient_1, mint_1)] = c.pool_order();
    let mut accounts = vec![
        // The pool PDA holds the NFT, so it signs as the position owner and fees land in our own vaults
        AccountMeta::new_readonly(pool.key(), true),
        AccountMeta::new_readonly(c.vault_nft.key(), false),
        AccountMeta::new(c.position.key(), false),
        AccountMeta::new(c.clmm_pool.key(), false),
        AccountMeta::new(c.protocol_position.key(), false),
        AccountMeta::new(c.clmm_vault_0.key(), false),
        AccountMeta::new(c.clmm_vault_1.key(), false),
        AccountMeta::new(c.tick_array_lower.key(), false),
        AccountMeta::new(c.tick_array_upper.key(), false),
        AccountMeta::new(recipient_0.key(), false),
        AccountMeta::new(recipient_1.key(), false),
        AccountMeta::new_readonly(c.token_program.key(), false),
        AccountMeta::new_readonly(c.token_program_2022.key(), false),
        AccountMeta::new_readonly(c.memo_program.key(), false),
        AccountMeta::new_readonly(mint_0.key(), false),
        AccountMeta::new_readonly(mint_1.key(), false),
    ];
    let mut infos = vec![
        pool.to_account_info(),
        c.vault_nft.clone(),
        c.position.clone(),
        c.clmm_pool.clone(),
        c.protocol_position.clone(),
        c.clmm_vault_0.clone(),
        c.clmm_vault_1.clone(),
        c.tick_array_lower.clone(),
        c.tick_array_upper.clone(),
        recipient_0.clone(),
        recipient_1.clone(),
        c.token_program.clone(),
        c.token_program_2022.clone(),
        c.memo_program.clone(),
        mint_0.clone(),
        mint_1.clone(),
        c.dex_program.clone(),
    ];
    for r in rem {
        accounts.push(AccountMeta { pubkey: r.key(), is_signer: false, is_writable: r.is_writable });
        infos.push(r.clone());
    }
    // liquidity, amount 0 min and amount 1 min, all zero
    let mut data = DECREASE_LIQUIDITY_V2.to_vec();
    data.extend_from_slice(&[0u8; 32]);

    let seeds = pool.signer_seeds();
    invoke_signed(&Instruction { program_id: c.dex_program.key(), accounts, data }, &infos, &[&seeds])?;
    Ok(())
}

/// Adds `liquidity` to a held Raydium position, paid out of our own collateral vaults, which take at most `max_0` and `max_1`
/// of the pool's two tokens, in the pool's own order
/// `rem` may hold the tick array bitmap extension, which Raydium wants when the position's range needs it
pub(crate) fn increase_raydium_liquidity<'info>(
    c: &RaydiumPosition<'info>,
    pool: &Account<'info, Pool>,
    rem: &[AccountInfo<'info>],
    liquidity: u128,
    max_0: u64,
    max_1: u64,
) -> Result<()> {
    let [(payer_0, mint_0), (payer_1, mint_1)] = c.pool_order();
    let mut accounts = vec![
        // The pool PDA holds the NFT and both vaults, so it signs as the position owner and as the tokens' owner
        AccountMeta::new_readonly(pool.key(), true),
        AccountMeta::new_readonly(c.vault_nft.key(), false),
        AccountMeta::new(c.clmm_pool.key(), false),
        AccountMeta::new(c.protocol_position.key(), false),
        AccountMeta::new(c.position.key(), false),
        AccountMeta::new(c.tick_array_lower.key(), false),
        AccountMeta::new(c.tick_array_upper.key(), false),
        AccountMeta::new(payer_0.key(), false),
        AccountMeta::new(payer_1.key(), false),
        AccountMeta::new(c.clmm_vault_0.key(), false),
        AccountMeta::new(c.clmm_vault_1.key(), false),
        AccountMeta::new_readonly(c.token_program.key(), false),
        AccountMeta::new_readonly(c.token_program_2022.key(), false),
        AccountMeta::new_readonly(mint_0.key(), false),
        AccountMeta::new_readonly(mint_1.key(), false),
    ];
    let mut infos = vec![
        pool.to_account_info(),
        c.vault_nft.clone(),
        c.clmm_pool.clone(),
        c.protocol_position.clone(),
        c.position.clone(),
        c.tick_array_lower.clone(),
        c.tick_array_upper.clone(),
        payer_0.clone(),
        payer_1.clone(),
        c.clmm_vault_0.clone(),
        c.clmm_vault_1.clone(),
        c.token_program.clone(),
        c.token_program_2022.clone(),
        mint_0.clone(),
        mint_1.clone(),
        c.dex_program.clone(),
    ];
    // Raydium reads the extension from the first remaining account, and nothing else is wanted there
    if !rem.is_empty() {
        let extension = c.bitmap_extension();
        if let Some(r) = rem.iter().find(|r| *r.key == extension) {
            accounts.push(AccountMeta { pubkey: r.key(), is_signer: false, is_writable: r.is_writable });
            infos.push(r.clone());
        }
    }
    // The liquidity is given, so there is no base flag
    let data = [&INCREASE_LIQUIDITY_V2[..], &liquidity.to_le_bytes(), &max_0.to_le_bytes(), &max_1.to_le_bytes(), &[0u8]].concat();

    let seeds = pool.signer_seeds();
    invoke_signed(&Instruction { program_id: c.dex_program.key(), accounts, data }, &infos, &[&seeds])?;
    Ok(())
}
