use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
    },
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    dlmm::{read_pair, read_position, MAX_BINS},
    error::PluribusError,
    events::*,
    instructions::{
        compound::{require_fair_bin, Compounder},
        liquidate::{require_not_worse, settle},
    },
    math::*,
    risk::*,
    state::*,
    token::{pull, push},
};

/// First 8 bytes of sha256("global:initialize_position2")
const INITIALIZE_POSITION: [u8; 8] = [0x8f, 0x13, 0xf2, 0x91, 0xd5, 0x0f, 0x68, 0x73];
/// First 8 bytes of sha256("global:update_position_operator")
const UPDATE_POSITION_OPERATOR: [u8; 8] = [0xca, 0xb8, 0x67, 0x8f, 0xb4, 0xbf, 0x74, 0xd9];
/// First 8 bytes of sha256("global:add_liquidity_by_strategy2")
const ADD_LIQUIDITY_BY_STRATEGY: [u8; 8] = [0x03, 0xdd, 0x95, 0xda, 0x6f, 0x8d, 0x76, 0xd5];
/// First 8 bytes of sha256("global:remove_liquidity_by_range2")
const REMOVE_LIQUIDITY_BY_RANGE: [u8; 8] = [0xcc, 0x02, 0xc3, 0x91, 0x35, 0x91, 0x91, 0xcd];
/// First 8 bytes of sha256("global:claim_fee2")
const CLAIM_FEE: [u8; 8] = [0x70, 0xbf, 0x65, 0xab, 0x1c, 0x90, 0x7f, 0xbb];
/// First 8 bytes of sha256("global:close_position2")
const CLOSE_POSITION: [u8; 8] = [0xae, 0x5a, 0x23, 0x73, 0xba, 0x28, 0x93, 0xe2];
/// Borsh for no transfer-hook accounts, which every `2` instruction takes last
const NO_HOOKS: [u8; 4] = [0; 4];
/// Meteora's strategy that spreads whatever it is given evenly, token Y under the active bin and token X over it,
/// in any mix of the two
const SPOT_IMBALANCED: u8 = 6;

const WRITABLE: u8 = 1;
const SIGNER: u8 = 2;

/// Calls the DLMM program with `accounts` and then the bin arrays, the pool PDA signing when `pool` is given
fn call<'info>(
    program: &AccountInfo<'info>,
    data: Vec<u8>,
    accounts: &[(&AccountInfo<'info>, u8)],
    bins: &[AccountInfo<'info>],
    pool: Option<&Account<'info, Pool>>,
) -> Result<()> {
    let mut metas = Vec::with_capacity(accounts.len() + bins.len());
    let mut infos = Vec::with_capacity(accounts.len() + bins.len());
    for (account, flags) in accounts {
        metas.push(AccountMeta { pubkey: account.key(), is_signer: flags & SIGNER != 0, is_writable: flags & WRITABLE != 0 });
        infos.push((*account).clone());
    }
    for bin in bins {
        metas.push(AccountMeta::new(bin.key(), false));
        infos.push(bin.clone());
    }
    let ix = Instruction { program_id: program.key(), accounts: metas, data };
    match pool {
        Some(pool) => invoke_signed(&ix, &infos, &[&pool.signer_seeds()])?,
        None => invoke(&ix, &infos)?,
    }
    Ok(())
}

/// Who signs for the tokens an add takes
enum Sender<'a, 'info> {
    /// A wallet that signed the transaction, whose own token accounts are spent
    Wallet(&'a AccountInfo<'info>),
    /// The pool PDA, which signs by its seeds for the position it owns and for the vaults it owns
    Pool(&'a Account<'info, Pool>),
}

/// The Meteora accounts a liquidity instruction passes through, with the two token accounts the pair pays into or draws from
struct Venue<'info> {
    program: AccountInfo<'info>,
    event_authority: AccountInfo<'info>,
    position: AccountInfo<'info>,
    lb_pair: AccountInfo<'info>,
    bitmap: AccountInfo<'info>,
    token_x: AccountInfo<'info>,
    token_y: AccountInfo<'info>,
    reserve_x: AccountInfo<'info>,
    reserve_y: AccountInfo<'info>,
    mint_x: AccountInfo<'info>,
    mint_y: AccountInfo<'info>,
    program_x: AccountInfo<'info>,
    program_y: AccountInfo<'info>,
}

/// The venue of an accounts struct, paying into or drawing from the two token accounts named
macro_rules! venue {
    ($a:expr, $x:ident, $y:ident) => {
        Venue {
            program: $a.dlmm_program.to_account_info(),
            event_authority: $a.event_authority.to_account_info(),
            position: $a.position.to_account_info(),
            lb_pair: $a.lb_pair.to_account_info(),
            bitmap: $a.bitmap_extension.to_account_info(),
            token_x: $a.$x.to_account_info(),
            token_y: $a.$y.to_account_info(),
            reserve_x: $a.reserve_x.to_account_info(),
            reserve_y: $a.reserve_y.to_account_info(),
            mint_x: $a.token_x_mint.to_account_info(),
            mint_y: $a.token_y_mint.to_account_info(),
            program_x: $a.token_x_program.to_account_info(),
            program_y: $a.token_y_program.to_account_info(),
        }
    };
}

/// The venue of an accounts struct whose token accounts are the protocol's own base token and USDC collateral vaults,
/// put in the order the pair keeps its two tokens, with `$bitmap` as the pair's bitmap extension
macro_rules! vault_venue {
    ($a:expr, $bitmap:expr) => {{
        let (base_vault, usdc_vault) = ($a.base_vault.to_account_info(), $a.usdc_collateral_vault.to_account_info());
        let (base_mint, usdc_mint) = ($a.base_mint.to_account_info(), $a.usdc_mint.to_account_info());
        let (token_x, token_y) = if $a.lp_market.base_first { (base_vault, usdc_vault) } else { (usdc_vault, base_vault) };
        let (mint_x, mint_y) = if $a.lp_market.base_first { (base_mint, usdc_mint) } else { (usdc_mint, base_mint) };
        Venue {
            program: $a.dlmm_program.to_account_info(),
            event_authority: $a.event_authority.to_account_info(),
            position: $a.position.to_account_info(),
            lb_pair: $a.lb_pair.to_account_info(),
            bitmap: $bitmap.to_account_info(),
            token_x,
            token_y,
            reserve_x: $a.reserve_x.to_account_info(),
            reserve_y: $a.reserve_y.to_account_info(),
            mint_x,
            mint_y,
            // Both of a listed pair's tokens are classic tokens
            program_x: $a.token_program.to_account_info(),
            program_y: $a.token_program.to_account_info(),
        }
    }};
}

impl<'info> Venue<'info> {
    /// The accounts adding and removing liquidity share, up to the one that signs
    fn liquidity<'a>(&'a self, sender: &'a AccountInfo<'info>) -> [(&'a AccountInfo<'info>, u8); 10] {
        [
            (&self.position, WRITABLE),
            (&self.lb_pair, WRITABLE),
            // A pair with no bitmap extension is passed the program itself there, which cannot be written to
            (&self.bitmap, self.bitmap.is_writable as u8),
            (&self.token_x, WRITABLE),
            (&self.token_y, WRITABLE),
            (&self.reserve_x, WRITABLE),
            (&self.reserve_y, WRITABLE),
            (&self.mint_x, 0),
            (&self.mint_y, 0),
            (sender, SIGNER),
        ]
    }

    /// Names who besides the owner may add liquidity, which only the pool PDA as owner can change
    fn set_operator(&self, pool: &Account<'info, Pool>, operator: Pubkey) -> Result<()> {
        let pool_info = pool.to_account_info();
        let accounts = [(&self.position, WRITABLE), (&pool_info, SIGNER), (&self.event_authority, 0), (&self.program, 0)];
        call(&self.program, [&UPDATE_POSITION_OPERATOR[..], operator.as_ref()].concat(), &accounts, &[], Some(pool))
    }

    /// Adds `sender`'s tokens across the position's whole range, in the shape `strategy` names
    fn add(&self, sender: Sender<'_, 'info>, amounts: (u64, u64), active: (i32, i32), range: (i32, i32), strategy: u8, bins: &[AccountInfo<'info>]) -> Result<()> {
        let (sender, pool) = match sender {
            Sender::Wallet(wallet) => (wallet.clone(), None),
            Sender::Pool(pool) => (pool.to_account_info(), Some(pool)),
        };
        let mut accounts = self.liquidity(&sender).to_vec();
        accounts.extend([(&self.program_x, 0), (&self.program_y, 0), (&self.event_authority, 0), (&self.program, 0)]);
        let data = [
            &ADD_LIQUIDITY_BY_STRATEGY[..],
            &amounts.0.to_le_bytes(),
            &amounts.1.to_le_bytes(),
            // The active bin the sender saw and how far it may have moved since
            &active.0.to_le_bytes(),
            &active.1.to_le_bytes(),
            &range.0.to_le_bytes(),
            &range.1.to_le_bytes(),
            &[strategy],
            // The strategy's own parameters, all left at their defaults
            &[0; 64],
            &NO_HOOKS,
        ]
        .concat();
        call(&self.program, data, &accounts, bins, pool)
    }

    /// Takes `bps` of every bin's liquidity out to the venue's token accounts, signed by the pool PDA as owner
    fn remove(&self, pool: &Account<'info, Pool>, memo: &AccountInfo<'info>, range: (i32, i32), bps: u16, bins: &[AccountInfo<'info>]) -> Result<()> {
        let pool_info = pool.to_account_info();
        let mut accounts = self.liquidity(&pool_info).to_vec();
        accounts.extend([(&self.program_x, 0), (&self.program_y, 0), (memo, 0), (&self.event_authority, 0), (&self.program, 0)]);
        let data = [&REMOVE_LIQUIDITY_BY_RANGE[..], &range.0.to_le_bytes(), &range.1.to_le_bytes(), &bps.to_le_bytes(), &NO_HOOKS].concat();
        call(&self.program, data, &accounts, bins, Some(pool))
    }

    /// Collects the position's trading fees into the venue's token accounts
    fn claim(&self, pool: &Account<'info, Pool>, memo: &AccountInfo<'info>, range: (i32, i32), bins: &[AccountInfo<'info>]) -> Result<()> {
        let pool_info = pool.to_account_info();
        let accounts = [
            (&self.lb_pair, WRITABLE),
            (&self.position, WRITABLE),
            (&pool_info, SIGNER),
            (&self.reserve_x, WRITABLE),
            (&self.reserve_y, WRITABLE),
            (&self.token_x, WRITABLE),
            (&self.token_y, WRITABLE),
            (&self.mint_x, 0),
            (&self.mint_y, 0),
            (&self.program_x, 0),
            (&self.program_y, 0),
            (memo, 0),
            (&self.event_authority, 0),
            (&self.program, 0),
        ];
        let data = [&CLAIM_FEE[..], &range.0.to_le_bytes(), &range.1.to_le_bytes(), &NO_HOOKS].concat();
        call(&self.program, data, &accounts, bins, Some(pool))
    }

    /// Closes the emptied position and sends its rent to `rent_to`
    fn close(&self, pool: &Account<'info, Pool>, rent_to: &AccountInfo<'info>) -> Result<()> {
        let pool_info = pool.to_account_info();
        let accounts = [(&self.position, WRITABLE), (&pool_info, SIGNER), (rent_to, WRITABLE), (&self.event_authority, 0), (&self.program, 0)];
        call(&self.program, CLOSE_POSITION.to_vec(), &accounts, &[], Some(pool))
    }
}

/// Balance of a token account, classic or Token-2022
fn balance(account: &AccountInfo) -> Result<u64> {
    let d = account.try_borrow_data()?;
    require!(d.len() >= 72, PluribusError::AccountMismatch);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

/// The bin arrays lead the remaining accounts and the health check's accounts follow
fn split<'a, 'info>(rem: &'a [AccountInfo<'info>], bin_arrays: u8) -> Result<(&'a [AccountInfo<'info>], &'a [AccountInfo<'info>])> {
    require!(rem.len() >= bin_arrays as usize, PluribusError::MissingAccount);
    Ok(rem.split_at(bin_arrays as usize))
}

#[derive(Accounts)]
pub struct DlmmOpen<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, owner.key().as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [LP_MARKET_SEED, lb_pair.key().as_ref()], bump = lp_market.bump)]
    pub lp_market: Box<Account<'info, LpMarket>>,
    /// The pair's priced token, whose own pause and activation delay apply to its positions too
    #[account(seeds = [ASSET_SEED, lp_market.base_mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Box<Account<'info, Asset>>,
    /// CHECK: The market seeds above pin this to a whitelisted pair
    pub lb_pair: UncheckedAccount<'info>,
    /// A fresh account the DLMM program turns into the position, so it must sign
    #[account(mut)]
    pub position: Signer<'info>,
    /// CHECK: The DLMM program checks this is its own event authority
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Pinned to the DLMM program id
    #[account(address = METEORA_DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// New liquidity is taken only by a live Meteora market whose base token is live too, as for any LP deposit
fn require_open(pool: &Pool, market: &LpMarket, base: &Asset) -> Result<()> {
    require_keys_eq!(market.dex_program, METEORA_DLMM_PROGRAM_ID, PluribusError::NotDlmmMarket);
    require!(!market.paused && !base.params.paused, PluribusError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let active = now >= pool.effective_at(market.active_at) && now >= pool.effective_at(base.active_at);
    require!(active, PluribusError::NotYetActive);
    Ok(())
}

/// Opens an empty position of `width` bins from `lower_bin_id` that the pool PDA owns, and books it to the account
/// A Meteora position can never change owner, so one a wallet already holds cannot be brought in:
/// the pool has to be the owner from the first instruction
pub fn handle_dlmm_open(ctx: Context<DlmmOpen>, lower_bin_id: i32, width: i32) -> Result<()> {
    let a = ctx.accounts;
    require_open(&a.pool, &a.lp_market, &a.base_asset)?;
    require!((1..=MAX_BINS).contains(&width), PluribusError::InvalidParams);
    let pool_info = a.pool.to_account_info();
    let accounts: [(&AccountInfo, u8); 7] = [
        (a.owner.as_ref(), WRITABLE | SIGNER),
        (a.position.as_ref(), WRITABLE | SIGNER),
        (a.lb_pair.as_ref(), 0),
        (&pool_info, SIGNER),
        (a.system_program.as_ref(), 0),
        (a.event_authority.as_ref(), 0),
        (a.dlmm_program.as_ref(), 0),
    ];
    let data = [&INITIALIZE_POSITION[..], &lower_bin_id.to_le_bytes(), &width.to_le_bytes()].concat();
    call(&a.dlmm_program, data, &accounts, &[], Some(&a.pool))?;
    // What came back must be what every later health check accepts, or the slot could never be valued
    let held = read_position(&a.position, &a.pool.key())?;
    require_keys_eq!(held.pair, a.lb_pair.key(), PluribusError::InvalidDlmmPosition);

    let position = a.position.key();
    a.credit.add_dlmm(&position)?;
    emit!(CollateralChanged { account: a.credit.key(), mint: position, kind: KIND_DLMM, amount: 1, deposit: true });
    Ok(())
}

#[derive(Accounts)]
pub struct DlmmAdd<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CREDIT_SEED, owner.key().as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [LP_MARKET_SEED, lb_pair.key().as_ref()], bump = lp_market.bump)]
    pub lp_market: Box<Account<'info, LpMarket>>,
    #[account(seeds = [ASSET_SEED, lp_market.base_mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Box<Account<'info, Asset>>,
    /// CHECK: Must be a position the account holds, which the handler checks
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: The market seeds above pin this to a whitelisted pair
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: The pair's bin array bitmap extension, or the DLMM program when it has none
    pub bitmap_extension: UncheckedAccount<'info>,
    /// CHECK: The owner's token X, which the DLMM program debits with the owner's signature
    #[account(mut)]
    pub owner_token_x: UncheckedAccount<'info>,
    /// CHECK: The owner's token Y, which the DLMM program debits with the owner's signature
    #[account(mut)]
    pub owner_token_y: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's own token X reserve
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's own token Y reserve
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's token X mint
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's token Y mint
    pub token_y_mint: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is token X's token program
    pub token_x_program: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is token Y's token program
    pub token_y_program: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is its own event authority
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Pinned to the DLMM program id
    #[account(address = METEORA_DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
}

/// Adds the owner's own tokens to a position the account holds, spread over its whole range
/// The bin arrays the range touches are the remaining accounts
pub fn handle_dlmm_add<'info>(
    ctx: Context<'info, DlmmAdd<'info>>,
    amount_x: u64,
    amount_y: u64,
    active_id: i32,
    max_active_bin_slippage: i32,
    strategy: u8,
) -> Result<()> {
    let a = ctx.accounts;
    require_open(&a.pool, &a.lp_market, &a.base_asset)?;
    let position = a.position.key();
    a.credit.find(KIND_DLMM, &position)?;
    let held = read_position(&a.position, &a.pool.key())?;
    // The market checked above must be the position's own, not another that happens to be open
    require_keys_eq!(held.pair, a.lb_pair.key(), PluribusError::PoolNotWhitelisted);
    let v = venue!(a, owner_token_x, owner_token_y);
    let before = (balance(&v.token_x)?, balance(&v.token_y)?);

    // Meteora lets only a position's owner or operator add to it, and takes the tokens from whoever signs
    // So the owner is made operator for this one call and dropped again, which leaves the pool alone in control:
    // an operator left in place could pull the liquidity out from under the debt
    v.set_operator(&a.pool, a.owner.key())?;
    v.add(Sender::Wallet(a.owner.as_ref()), (amount_x, amount_y), (active_id, max_active_bin_slippage), (held.lower, held.upper), strategy, ctx.remaining_accounts)?;
    v.set_operator(&a.pool, Pubkey::default())?;
    read_position(&a.position, &a.pool.key())?;

    emit!(DlmmLiquidityChanged {
        account: a.credit.key(),
        position,
        amount_x: before.0.saturating_sub(balance(&v.token_x)?),
        amount_y: before.1.saturating_sub(balance(&v.token_y)?),
        deposit: true,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct DlmmExit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, owner.key().as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: Must be a position the account holds, which the handler checks
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the position's pair
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: The pair's bin array bitmap extension, or the DLMM program when it has none
    pub bitmap_extension: UncheckedAccount<'info>,
    /// CHECK: Where the owner takes token X
    #[account(mut)]
    pub owner_token_x: UncheckedAccount<'info>,
    /// CHECK: Where the owner takes token Y
    #[account(mut)]
    pub owner_token_y: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's own token X reserve
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's own token Y reserve
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's token X mint
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's token Y mint
    pub token_y_mint: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is token X's token program
    pub token_x_program: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is token Y's token program
    pub token_y_program: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the memo program
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is its own event authority
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Pinned to the DLMM program id
    #[account(address = METEORA_DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
}

/// Takes `bps` of the liquidity in every bin of a position out to the owner
/// The first `bin_arrays` remaining accounts are the bin arrays of its range, the rest feed the health check
pub fn handle_dlmm_remove<'info>(ctx: Context<'info, DlmmExit<'info>>, bps: u16, bin_arrays: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    require!(bps > 0 && u128::from(bps) <= BPS, PluribusError::InvalidParams);
    a.pool.accrue(now)?;
    book_premium(&mut a.pool, &mut a.credit, now)?;
    let position = a.position.key();
    a.credit.find(KIND_DLMM, &position)?;
    let (bins, health) = split(ctx.remaining_accounts, bin_arrays)?;
    let held = read_position(&a.position, &a.pool.key())?;
    let v = venue!(a, owner_token_x, owner_token_y);
    let before = (balance(&v.token_x)?, balance(&v.token_y)?);
    v.remove(&a.pool, a.memo_program.as_ref(), (held.lower, held.upper), bps, bins)?;
    // The health check reads the position as the withdrawal left it
    require_within_limit(&a.pool, &mut a.credit, health, now)?;
    emit!(DlmmLiquidityChanged {
        account: a.credit.key(),
        position,
        amount_x: balance(&v.token_x)?.saturating_sub(before.0),
        amount_y: balance(&v.token_y)?.saturating_sub(before.1),
        deposit: false,
    });
    Ok(())
}

/// Closes an emptied position, pays its uncollected fees and its rent to the owner and frees the slot
/// With `bin_arrays` at zero no fees are collected, for a position that never held liquidity and so has no bin arrays to name
pub fn handle_dlmm_close<'info>(ctx: Context<'info, DlmmExit<'info>>, bin_arrays: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    a.pool.accrue(now)?;
    book_premium(&mut a.pool, &mut a.credit, now)?;
    let position = a.position.key();
    a.credit.remove_dlmm(&position)?;
    let (bins, health) = split(ctx.remaining_accounts, bin_arrays)?;
    let held = read_position(&a.position, &a.pool.key())?;
    let v = venue!(a, owner_token_x, owner_token_y);
    if !bins.is_empty() {
        // Fees never count as collateral, so paying them out cannot lower health
        v.claim(&a.pool, a.memo_program.as_ref(), (held.lower, held.upper), bins)?;
    }
    // The DLMM program refuses to close a position that still holds liquidity or fees
    v.close(&a.pool, a.owner.as_ref())?;
    require_within_limit(&a.pool, &mut a.credit, health, now)?;
    emit!(CollateralChanged { account: a.credit.key(), mint: position, kind: KIND_DLMM, amount: 1, deposit: false });
    Ok(())
}

#[derive(Accounts)]
pub struct DlmmLiquidate<'info> {
    pub liquidator: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint)]
    pub liquidator_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Only receives a closed position's rent, and must be the account owner who paid it
    #[account(mut, address = credit.owner)]
    pub owner: UncheckedAccount<'info>,
    /// Moves the USDC, which is always a classic token
    #[account(address = anchor_spl::token::ID @ PluribusError::AccountMismatch)]
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Must be a position the account holds, which the handler checks
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the position's pair
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: The pair's bin array bitmap extension, or the DLMM program when it has none
    pub bitmap_extension: UncheckedAccount<'info>,
    /// CHECK: Where the liquidator takes token X
    #[account(mut)]
    pub liquidator_token_x: UncheckedAccount<'info>,
    /// CHECK: Where the liquidator takes token Y
    #[account(mut)]
    pub liquidator_token_y: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's own token X reserve
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's own token Y reserve
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's token X mint
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's token Y mint
    pub token_y_mint: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is token X's token program
    pub token_x_program: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is token Y's token program
    pub token_y_program: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the memo program
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is its own event authority
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Pinned to the DLMM program id
    #[account(address = METEORA_DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
}

/// The liquidator repays USDC and takes the same share of every bin of the position, worth that plus the bonus
/// A position has no NFT to hand over, so the pool PDA removes the liquidity straight into the liquidator's token accounts
/// The first `bin_arrays` remaining accounts are the bin arrays of its range, the rest feed the health check
/// With `bin_arrays` at zero nothing is taken out, which is how a position that was never funded gets closed
pub fn handle_dlmm_liquidate<'info>(ctx: Context<'info, DlmmLiquidate<'info>>, repay_amount: u64, bin_arrays: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    a.pool.accrue(now)?;
    book_premium(&mut a.pool, &mut a.credit, now)?;
    let position = a.position.key();
    let i = a.credit.find(KIND_DLMM, &position)?;
    let (bins, health) = split(ctx.remaining_accounts, bin_arrays)?;
    let h = evaluate(&a.pool, &a.credit, health, now, Scope::Liquidation)?;
    let (debt, limit) = (a.pool.debt_of(&a.credit)?, h.liquidation_limit());
    require!(debt > limit, PluribusError::NotLiquidatable);

    let market = h.market[i];
    let bonus = BPS + a.pool.params.liq_bonus_bps as u128;
    let max_repay = mul_div_floor(debt, a.pool.params.close_factor_bps as u128, BPS)?;
    // A position priced at nothing goes whole for no payment: left in place it blocks the write-off
    // and the debt stays behind lender shares for good
    let worthless = market == 0;
    // The part of the position the payment buys at the bonus discount, in bps of every bin
    let part = if worthless { BPS } else { mul_div_floor((repay_amount as u128).min(max_repay), bonus, market)?.min(BPS) };
    // Charged for what that part is worth, so rounding the part down never overcharges
    let repay = if worthless { 0 } else { mul_div_ceil(market, part, bonus)?.min(max_repay) };
    require!(part > 0 && (repay > 0 || worthless), PluribusError::ZeroAmount);

    let mut after = h.maint;
    for s in 0..h.scenarios() {
        after[s] -= h.pos_maint[i][s] - mul_div_floor(h.pos_maint[i][s], BPS - part, BPS)?;
    }
    require_not_worse(debt, limit, debt - repay, worst(&after, h.scenarios()))?;

    let repay = to_u64(repay)?;
    if repay > 0 {
        a.pool.repay(&mut a.credit, repay)?;
        pull(&a.token_program, &a.usdc_mint, &a.liquidator_usdc, &a.usdc_vault, &a.liquidator, repay)?;
    }
    let held = read_position(&a.position, &a.pool.key())?;
    let range = (held.lower, held.upper);
    let v = venue!(a, liquidator_token_x, liquidator_token_y);
    // A position that never held liquidity may have no bin arrays to name, and then there is nothing to take out of it
    // Leaving them out of any other position only costs the liquidator what it paid for
    if !bins.is_empty() {
        v.remove(&a.pool, a.memo_program.as_ref(), range, part as u16, bins)?;
    }
    if part == BPS {
        // Sold whole it goes with the fees it has not collected, as an LP NFT does, and its rent returns to the borrower
        if !bins.is_empty() {
            v.claim(&a.pool, a.memo_program.as_ref(), range, bins)?;
        }
        // The DLMM program refuses to close a position that still holds liquidity or fees
        v.close(&a.pool, a.owner.as_ref())?;
        a.credit.remove_dlmm(&position)?;
    }
    emit!(Liquidated {
        account: a.credit.key(),
        liquidator: a.liquidator.key(),
        mint: position,
        kind: KIND_DLMM,
        repaid: repay,
        // In bps of the position, since it has no units of its own
        seized: part as u64,
        debt: to_u64(a.pool.debt_of(&a.credit)?)?,
    });
    settle(&mut a.pool, &mut a.credit, now)
}

#[derive(Accounts)]
pub struct DlmmAutopay<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [LP_MARKET_SEED, lb_pair.key().as_ref()], bump = lp_market.bump)]
    pub lp_market: Box<Account<'info, LpMarket>>,
    /// CHECK: The market seeds above pin this to a whitelisted pair
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: Must be a position the account holds in this pair, which the handler checks
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_SEED, lp_market.base_mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Box<Account<'info, Asset>>,
    #[account(mut, address = base_asset.vault)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = lp_market.base_mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [ASSET_SEED, usdc_mint.key().as_ref()], bump = usdc_asset.bump)]
    pub usdc_asset: Box<Account<'info, Asset>>,
    #[account(mut, address = usdc_asset.vault)]
    pub usdc_collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: The DLMM program checks this is the pair's own token X reserve
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's own token Y reserve
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// Both of a listed pair's tokens are classic tokens
    #[account(address = anchor_spl::token::ID @ PluribusError::AccountMismatch)]
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: The DLMM program checks this is the memo program
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is its own event authority
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Pinned to the DLMM program id
    #[account(address = METEORA_DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
}

/// Permissionless: collects a held position's trading fees from Meteora into the protocol's own vaults
/// The USDC part repays debt and the rest stays in the account as collateral, as with Orca fees
/// The bin arrays of the position's range are the remaining accounts
pub fn handle_dlmm_autopay<'info>(ctx: Context<'info, DlmmAutopay<'info>>) -> Result<()> {
    let a = ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    a.pool.accrue(now)?;
    book_premium(&mut a.pool, &mut a.credit, now)?;
    let position = a.position.key();
    let slot = a.credit.find(KIND_DLMM, &position)?;
    // A position set to compound keeps its fees for that, which only its owner can switch off
    require!(a.credit.compound_slippage_bps[slot] == 0, PluribusError::CompoundOn);
    require_keys_eq!(a.lp_market.dex_program, METEORA_DLMM_PROGRAM_ID, PluribusError::NotDlmmMarket);
    let held = read_position(&a.position, &a.pool.key())?;
    require_keys_eq!(held.pair, a.lb_pair.key(), PluribusError::PoolNotWhitelisted);

    // The pool PDA owns the position, so it signs for the fees and they land in our own vaults,
    // the base token on whichever side the pair keeps it
    // Collecting fees never reads the bitmap extension
    let v = vault_venue!(a, a.dlmm_program);
    v.claim(&a.pool, a.memo_program.as_ref(), (held.lower, held.upper), ctx.remaining_accounts)?;

    // What arrived is measured from the vault balances, not taken from Meteora's word
    let (base_before, usdc_before) = (a.base_vault.amount, a.usdc_collateral_vault.amount);
    a.base_vault.reload()?;
    a.usdc_collateral_vault.reload()?;
    let base_fee = a.base_vault.amount.saturating_sub(base_before);
    let usdc_fee = a.usdc_collateral_vault.amount.saturating_sub(usdc_before);

    if base_fee > 0 {
        let base_mint = a.base_asset.mint;
        a.credit.add_token(&base_mint, base_fee)?;
        a.base_asset.total_deposited = a.base_asset.total_deposited.saturating_add(base_fee);
        emit!(CollateralChanged { account: a.credit.key(), mint: base_mint, kind: KIND_TOKEN, amount: base_fee, deposit: true });
    }

    let owed = to_u64((usdc_fee as u128).min(a.pool.debt_of(&a.credit)?))?;
    // An amount too small to retire a debt share is kept as collateral instead
    let paid = if owed > 0 && a.pool.retires_debt(&a.credit, owed)? { a.pool.repay(&mut a.credit, owed)? } else { 0 };
    if paid > 0 {
        push(&a.token_program, &a.usdc_mint, &a.usdc_collateral_vault, &a.usdc_vault, &a.pool, paid)?;
        emit!(Repaid {
            account: a.credit.key(),
            payer: a.caller.key(),
            amount: paid,
            debt: to_u64(a.pool.debt_of(&a.credit)?)?,
            source: 1,
        });
    }
    let kept = usdc_fee - paid;
    if kept > 0 {
        let usdc = a.usdc_mint.key();
        a.credit.add_token(&usdc, kept)?;
        a.usdc_asset.total_deposited = a.usdc_asset.total_deposited.saturating_add(kept);
        emit!(CollateralChanged { account: a.credit.key(), mint: usdc, kind: KIND_TOKEN, amount: kept, deposit: true });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct CompoundDlmm<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [LP_MARKET_SEED, lb_pair.key().as_ref()], bump = lp_market.bump)]
    pub lp_market: Box<Account<'info, LpMarket>>,
    /// CHECK: The market seeds above pin this to a whitelisted pair
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: Must be a position the account holds in this pair, which the handler checks
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_SEED, lp_market.base_mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Box<Account<'info, Asset>>,
    #[account(mut, address = base_asset.vault)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = lp_market.base_mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: The base token's price account, checked against the asset's feed or mint when read
    pub base_price: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_SEED, usdc_mint.key().as_ref()], bump = usdc_asset.bump)]
    pub usdc_asset: Box<Account<'info, Asset>>,
    #[account(mut, address = usdc_asset.vault)]
    pub usdc_collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    /// The caller's bounty in the base token, to any account it names, never one of the protocol's vaults
    #[account(mut, token::mint = base_mint, constraint = bounty_base.key() != base_vault.key() @ PluribusError::AccountMismatch)]
    pub bounty_base: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The caller's bounty in USDC
    #[account(mut, token::mint = usdc_mint, constraint = bounty_usdc.key() != usdc_collateral_vault.key() @ PluribusError::AccountMismatch)]
    pub bounty_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: The pair's bin array bitmap extension, or the DLMM program when it has none
    pub bitmap_extension: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's own token X reserve
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is the pair's own token Y reserve
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// Both of a listed pair's tokens are classic tokens
    #[account(address = anchor_spl::token::ID @ PluribusError::AccountMismatch)]
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: The DLMM program checks this is the memo program
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: The DLMM program checks this is its own event authority
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Pinned to the DLMM program id
    #[account(address = METEORA_DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
}

/// The accounts a compound pays out of and books into, from the accounts struct of one
macro_rules! compounder {
    ($a:expr) => {
        Compounder {
            pool: &$a.pool,
            credit: &mut $a.credit,
            base_asset: &mut $a.base_asset,
            base_mint: &$a.base_mint,
            base_vault: &mut $a.base_vault,
            usdc_asset: &mut $a.usdc_asset,
            usdc_mint: &$a.usdc_mint,
            usdc_collateral_vault: &mut $a.usdc_collateral_vault,
            bounty_base: &$a.bounty_base,
            bounty_usdc: &$a.bounty_usdc,
            token_program: &$a.token_program,
            // Both of a listed pair's tokens are classic tokens
            base_token_program: &$a.token_program,
        }
    };
}

/// Permissionless: collects a held Meteora position's trading fees, pays the caller's recipient its share, and adds the rest
/// back across the position's range at the pair's price, which must sit within the owner's tolerance of the oracle's
/// The pool PDA owns the position and both vaults, so it signs for the add itself
/// Whatever the range cannot take, or Meteora leaves unspent, stays in the account as collateral; no health check is needed,
/// since fees never counted
/// The bin arrays of the position's range are the remaining accounts
pub fn handle_compound_dlmm<'info>(ctx: Context<'info, CompoundDlmm<'info>>) -> Result<()> {
    let a = ctx.accounts;
    let position = a.position.key();
    a.credit.find(KIND_DLMM, &position)?;
    require_keys_eq!(a.lp_market.dex_program, METEORA_DLMM_PROGRAM_ID, PluribusError::NotDlmmMarket);
    let held = read_position(&a.position, &a.pool.key())?;
    require_keys_eq!(held.pair, a.lb_pair.key(), PluribusError::PoolNotWhitelisted);
    let pair = read_pair(&a.lb_pair)?;
    let base_first = a.lp_market.base_first;
    require_fair_bin(&a.pool, &a.credit, &position, &a.base_asset, &a.base_price, &pair, base_first)?;

    let before = (a.base_vault.amount, a.usdc_collateral_vault.amount);
    let range = (held.lower, held.upper);
    let v = vault_venue!(a, a.bitmap_extension);
    v.claim(&a.pool, a.memo_program.as_ref(), range, ctx.remaining_accounts)?;
    let fees = compounder!(a).take_bounty(before)?;

    let (left_base, left_usdc) = fees.left();
    let (x, y) = if base_first { (left_base, left_usdc) } else { (left_usdc, left_base) };
    // Bins above the active one hold only token X and bins below it only token Y, so a range wholly on one side of the
    // price takes only that token, and the other stays behind as collateral
    let x = if pair.active_id > held.upper { 0 } else { x };
    let y = if pair.active_id < held.lower { 0 } else { y };
    if x > 0 || y > 0 {
        // The price guard above has already tied the pair's price to the oracle's, so the add takes the active bin as it is
        v.add(Sender::Pool(&a.pool), (x, y), (pair.active_id, 0), range, SPOT_IMBALANCED, ctx.remaining_accounts)?;
    }
    compounder!(a).finish(before, fees, position)
}
