use anchor_lang::prelude::*;

#[error_code]
pub enum PluribusError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Asset or pool is paused")]
    Paused,
    #[msg("Deposit cap reached")]
    DepositCap,
    #[msg("No free position slot")]
    TooManyPositions,
    #[msg("Position not found")]
    PositionNotFound,
    #[msg("Not enough collateral in the position")]
    InsufficientCollateral,
    #[msg("Missing account for the health check")]
    MissingAccount,
    #[msg("Account does not match the position")]
    AccountMismatch,
    #[msg("Account has the wrong owner program")]
    WrongOwner,
    #[msg("Price account is not valid for this asset")]
    InvalidPriceAccount,
    #[msg("Price is stale")]
    StalePrice,
    #[msg("Price confidence interval is too wide")]
    PriceTooUncertain,
    #[msg("Not an Orca Whirlpool position")]
    InvalidLpPosition,
    #[msg("Whirlpool is not whitelisted")]
    PoolNotWhitelisted,
    #[msg("Only classic SPL Token mints can be collateral")]
    UnsupportedMint,
    #[msg("Debt would exceed the credit limit")]
    ExceedsCreditLimit,
    #[msg("Account is healthy")]
    NotLiquidatable,
    #[msg("Liquidation would not improve health")]
    HealthNotImproved,
    #[msg("Not enough liquidity in the pool")]
    InsufficientLiquidity,
    #[msg("Pool has no lender assets left")]
    PoolInsolvent,
    #[msg("Demo feed is disabled")]
    DemoDisabled,
    #[msg("Only the program's upgrade authority can initialize the pool")]
    NotUpgradeAuthority,
}
