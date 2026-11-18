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
    /// Lenders' interest not yet paid out, which takes losses first
    pub covered_by_buffer: u64,
    pub covered_by_reserves: u64,
    pub covered_by_protocol_fees: u64,
    pub covered_by_junior: u64,
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
    pub junior: bool,
}

/// Senior shares turned into junior shares, `value` USDC moving between the tranches
#[event]
pub struct TrancheConverted {
    pub lender: Pubkey,
    pub shares: u64,
    pub value: u64,
    pub minted: u64,
}

#[event]
pub struct JuniorExitRequested {
    pub owner: Pubkey,
    pub shares: u64,
    /// The most the exit can pay, before its fee
    pub value: u64,
    pub unlock_at: i64,
    pub deadline: i64,
}

/// `paid` is USDC, or its worth in senior shares when `in_usdc` is false, after the `fee` left with junior lenders
#[event]
pub struct JuniorExitClaimed {
    pub owner: Pubkey,
    pub shares: u64,
    pub value: u64,
    pub fee: u64,
    pub paid: u64,
    pub in_usdc: bool,
}

/// `returned` of the queued `shares` went back to the owner, the rest were burned with the yield earned while queued
#[event]
pub struct JuniorExitCancelled {
    pub owner: Pubkey,
    pub shares: u64,
    pub returned: u64,
    pub lapsed: bool,
}

/// Junior exits are frozen until `until`, which is the present when a pause is lifted
#[event]
pub struct JuniorExitsPaused {
    pub until: i64,
}

/// A change to the pool, an asset or an LP market, named by `target`, waits until `effective_at`
#[event]
pub struct ChangeQueued {
    pub target: Pubkey,
    pub effective_at: i64,
}

/// A payout epoch opened: `budget` is paid out of `buffer` evenly until `end`, split between the tranches by their weights
#[event]
pub struct EpochOpened {
    pub start: i64,
    pub end: i64,
    pub budget: u64,
    pub buffer: u64,
}

/// A price sample folded into `mint`'s volatility, with the dynamic shocks it now gives in bps
#[event]
pub struct VolUpdated {
    pub mint: Pubkey,
    pub price: u64,
    pub shock_init_bps: u64,
    pub shock_maint_bps: u64,
}

#[event]
pub struct ChangeApplied {
    pub target: Pubkey,
}

#[event]
pub struct ChangeCancelled {
    pub target: Pubkey,
}

#[event]
pub struct DemoPriceSet {
    pub mint: Pubkey,
    pub price: u64,
}

#[event]
pub struct ProtocolFeesCollected {
    pub amount: u64,
}

/// Senior shares queued for withdrawal: `value` is the most they can pay, and `ticket` their place in the queue
#[event]
pub struct SeniorExitRequested {
    pub owner: Pubkey,
    pub ticket: u64,
    pub shares: u64,
    pub value: u64,
}

/// The queue reached `ticket`: `paid` USDC went to the owner, or nothing when the exit had been cancelled
#[event]
pub struct SeniorExitSettled {
    pub owner: Pubkey,
    pub ticket: u64,
    pub shares: u64,
    pub value: u64,
    pub paid: u64,
    pub cancelled: bool,
}

/// `returned` of the queued `shares` went back to the owner, the rest were burned with the yield earned while queued
#[event]
pub struct SeniorExitCancelled {
    pub owner: Pubkey,
    pub ticket: u64,
    pub shares: u64,
    pub returned: u64,
}
