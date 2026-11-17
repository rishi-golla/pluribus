use anchor_lang::prelude::*;

use crate::{constants::*, error::PluribusError, math::*, state::*};

/// First 8 bytes of sha256("account:PriceUpdateV2")
const PRICE_UPDATE_DISCRIMINATOR: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];
/// Borsh tag of VerificationLevel::Full
const VERIFICATION_FULL: u8 = 1;

pub struct Quote {
    pub price: u128,
    pub conf: u128,
    pub publish_time: i64,
}

/// Loads one of this program's accounts from the remaining accounts, checking owner and discriminator
pub fn load<T: AccountDeserialize>(acc: &AccountInfo) -> Result<T> {
    require_keys_eq!(*acc.owner, crate::ID, PluribusError::WrongOwner);
    T::try_deserialize(&mut &acc.try_borrow_data()?[..])
}

/// Collateral price for `asset` in USDC with 6 decimals, taken at the low end of the confidence band
/// Fails when the price is stale or too uncertain, so anything that needs a health check stops
pub fn read_price(pool: &Pool, asset: &Asset, acc: &AccountInfo, now: i64) -> Result<u128> {
    checked_low(read_quote(pool, asset, acc)?, &asset.params, now)
}

/// The low end of a quote's band, once it is fresh and certain enough for `params`
fn checked_low(q: Quote, p: &AssetParams, now: i64) -> Result<u128> {
    require!(q.price > 0, PluribusError::InvalidPriceAccount);
    require!(now.saturating_sub(q.publish_time) <= p.max_price_age_secs as i64, PluribusError::StalePrice);
    require!(q.conf * BPS <= q.price * p.max_conf_bps as u128, PluribusError::PriceTooUncertain);
    Ok(q.price - q.conf)
}

/// The raw quote for `asset`, from its demo account in demo mode or its Pyth account otherwise, checked for the right feed
pub fn read_quote(pool: &Pool, asset: &Asset, acc: &AccountInfo) -> Result<Quote> {
    quote_for(pool, &asset.mint, &asset.params.pyth_feed_id, acc)
}

fn quote_for(pool: &Pool, mint: &Pubkey, feed: &[u8; 32], acc: &AccountInfo) -> Result<Quote> {
    if pool.demo_mode {
        demo_quote(mint, acc)
    } else {
        pyth_quote(feed, acc)
    }
}

/// What a staking token's SOL backing is worth per whole token, with SOL at the low end of its band
/// `pool_acc` is the stake pool for RATE_STAKE_POOL and unused for RATE_FIXED
pub fn backing_price(pool: &Pool, asset: &Asset, sol_acc: &AccountInfo, pool_acc: Option<&AccountInfo>, now: i64) -> Result<u128> {
    let p = &asset.params;
    let sol = checked_low(quote_for(pool, &p.rate_base_mint, &p.rate_feed_id, sol_acc)?, p, now)?;
    // Lamports behind `den` base units of the token
    let (lamports, units) = match p.rate_source {
        RATE_FIXED => (p.fixed_rate as u128, pow10(asset.decimals)?),
        RATE_STAKE_POOL => stake_pool_rate(asset, pool_acc.ok_or_else(|| error!(PluribusError::MissingAccount))?)?,
        _ => return err!(PluribusError::InvalidParams),
    };
    mul_div_floor(sol, lamports.checked_mul(pow10(asset.decimals)?).ok_or_else(|| error!(PluribusError::MathOverflow))?, units * LAMPORTS_PER_SOL)
}

/// Total lamports and pool token supply of an SPL stake pool, checked to be the asset's own pool and updated this epoch or the last
fn stake_pool_rate(asset: &Asset, acc: &AccountInfo) -> Result<(u128, u128)> {
    require!(STAKE_POOL_PROGRAMS.contains(acc.owner), PluribusError::InvalidPriceAccount);
    require_keys_eq!(acc.key(), asset.params.rate_account, PluribusError::InvalidPriceAccount);
    let d = acc.try_borrow_data()?;
    // Layout: account type u8 = 1 for a pool | 7 pubkeys and a bump | pool mint at 162 | total lamports u64 at 258 | supply u64 at 266 | last update epoch u64 at 274
    require!(d.len() >= 282 && d[0] == 1 && d[162..194] == asset.mint.to_bytes(), PluribusError::InvalidPriceAccount);
    let lamports = u64::from_le_bytes(d[258..266].try_into().unwrap());
    let supply = u64::from_le_bytes(d[266..274].try_into().unwrap());
    let epoch = u64::from_le_bytes(d[274..282].try_into().unwrap());
    // A pool not brought up to date would miss a slash, which is the one thing that lowers the rate
    require!(epoch + 1 >= Clock::get()?.epoch && supply > 0, PluribusError::StalePrice);
    Ok((lamports as u128, supply as u128))
}

fn demo_quote(mint: &Pubkey, acc: &AccountInfo) -> Result<Quote> {
    let demo: DemoPrice = load(acc).map_err(|_| error!(PluribusError::InvalidPriceAccount))?;
    require_keys_eq!(demo.mint, *mint, PluribusError::InvalidPriceAccount);
    Ok(Quote { price: demo.price as u128, conf: demo.conf as u128, publish_time: demo.publish_time })
}

/// Reads a Pyth receiver PriceUpdateV2 account by hand, since the layout is fixed once the update is fully verified
fn pyth_quote(feed: &[u8; 32], acc: &AccountInfo) -> Result<Quote> {
    require_keys_eq!(*acc.owner, PYTH_RECEIVER_ID, PluribusError::InvalidPriceAccount);
    let d = acc.try_borrow_data()?;
    // Layout: disc 8 | write authority 32 | verification 1 | feed id 32 | price i64 | conf u64 | expo i32 | publish time i64
    require!(
        d.len() >= 101 && d[..8] == PRICE_UPDATE_DISCRIMINATOR && d[40] == VERIFICATION_FULL && d[41..73] == *feed,
        PluribusError::InvalidPriceAccount
    );
    let price = i64::from_le_bytes(d[73..81].try_into().unwrap());
    let conf = u64::from_le_bytes(d[81..89].try_into().unwrap());
    let expo = i32::from_le_bytes(d[89..93].try_into().unwrap());
    let publish_time = i64::from_le_bytes(d[93..101].try_into().unwrap());
    require!(price > 0 && (-18..=0).contains(&expo), PluribusError::InvalidPriceAccount);
    // Rescale to 6 decimals: price down, confidence up
    let (num, den) = (PRICE_ONE, pow10(expo.unsigned_abs() as u8)?);
    Ok(Quote {
        price: mul_div_floor(price as u128, num, den)?,
        conf: mul_div_ceil(conf as u128, num, den)?,
        publish_time,
    })
}
