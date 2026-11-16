use anchor_lang::prelude::*;

#[event]
pub struct AccountOpened {
    pub account: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct CollateralChanged {
    pub account: Pubkey,
    pub mint: Pubkey,
    pub kind: u8,
    pub amount: u64,
    pub deposit: bool,
}

#[event]
pub struct Drawn {
    pub account: Pubkey,
    pub amount: u64,
    pub debt: u64,
}

#[event]
pub struct Repaid {
    pub account: Pubkey,
    pub payer: Pubkey,
    pub amount: u64,
    pub debt: u64,
    /// Where the USDC came from: 0 wallet, 1 autopay from LP fees, 2 the account's own USDC collateral
    pub source: u8,
}

#[event]
pub struct Liquidated {
    pub account: Pubkey,
    pub liquidator: Pubkey,
    pub mint: Pubkey,
    pub kind: u8,
    pub repaid: u64,
    pub seized: u64,
    pub debt: u64,
}

#[event]
pub struct BadDebt {
    pub account: Pubkey,
    pub loss: u64,
    pub covered_by_reserves: u64,
}

#[event]
pub struct TierChanged {
    pub account: Pubkey,
    pub from: u8,
    pub to: u8,
}

#[event]
pub struct LenderMoved {
    pub lender: Pubkey,
    pub usdc: u64,
    pub shares: u64,
    pub deposit: bool,
}

#[event]
pub struct DemoPriceSet {
    pub mint: Pubkey,
    pub price: u64,
}
