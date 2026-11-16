use anchor_lang::prelude::*;

use crate::{constants::*, error::PluribusError, math::*, state::*};

/// First 8 bytes of sha256("account:PriceUpdateV2")
const PRICE_UPDATE_DISCRIMINATOR: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];
/// Borsh tag of VerificationLevel::Full
const VERIFICATION_FULL: u8 = 1;

struct Quote {
    price: u128,
    conf: u128,
    publish_time: i64,
}

/// Loads one of this program's accounts from the remaining accounts, checking owner and discriminator
pub fn load<T: AccountDeserialize>(acc: &AccountInfo) -> Result<T> {
    require_keys_eq!(*acc.owner, crate::ID, PluribusError::WrongOwner);
    T::try_deserialize(&mut &acc.try_borrow_data()?[..])
}

/// Collateral price for `asset` in USDC with 6 decimals, taken at the low end of the confidence band
/// Fails when the price is stale or too uncertain, so anything that needs a health check stops
pub fn read_price(pool: &Pool, asset: &Asset, acc: &AccountInfo, now: i64) -> Result<u128> {
    let q = if pool.demo_mode { demo_quote(asset, acc)? } else { pyth_quote(asset, acc)? };
    let p = &asset.params;
    require!(q.price > 0, PluribusError::InvalidPriceAccount);
    require!(now.saturating_sub(q.publish_time) <= p.max_price_age_secs as i64, PluribusError::StalePrice);
    require!(q.conf * BPS <= q.price * p.max_conf_bps as u128, PluribusError::PriceTooUncertain);
    Ok(q.price - q.conf)
}

fn demo_quote(asset: &Asset, acc: &AccountInfo) -> Result<Quote> {
    let demo: DemoPrice = load(acc).map_err(|_| error!(PluribusError::InvalidPriceAccount))?;
    require_keys_eq!(demo.mint, asset.mint, PluribusError::InvalidPriceAccount);
    Ok(Quote { price: demo.price as u128, conf: demo.conf as u128, publish_time: demo.publish_time })
}

/// Reads a Pyth receiver PriceUpdateV2 account by hand, since the layout is fixed once the update is fully verified
fn pyth_quote(asset: &Asset, acc: &AccountInfo) -> Result<Quote> {
    require_keys_eq!(*acc.owner, PYTH_RECEIVER_ID, PluribusError::InvalidPriceAccount);
    let d = acc.try_borrow_data()?;
    // Layout: disc 8 | write authority 32 | verification 1 | feed id 32 | price i64 | conf u64 | expo i32 | publish time i64
    require!(
        d.len() >= 101
            && d[..8] == PRICE_UPDATE_DISCRIMINATOR
            && d[40] == VERIFICATION_FULL
            && d[41..73] == asset.params.pyth_feed_id,
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
