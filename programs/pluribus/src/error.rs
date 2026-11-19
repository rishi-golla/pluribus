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
    #[msg("Demo feed is disabled")]
    DemoDisabled,
    #[msg("Only the program's upgrade authority can initialize the pool")]
    NotUpgradeAuthority,
    #[msg("Junior shares leave through the exit queue")]
    JuniorExitQueue,
    #[msg("Junior exits are paused by governance")]
    ExitsPaused,
    #[msg("The exit is still in its waiting period")]
    ExitNotReady,
    #[msg("The exit lapsed: its claim window has passed")]
    ExitLapsed,
    #[msg("Only the owner can cancel an exit before it lapses")]
    ExitNotLapsed,
    #[msg("A pause must fit the cap and follow the last one by the required gap")]
    PauseNotAllowed,
    #[msg("No change is waiting")]
    NoPendingChange,
    #[msg("The change is still waiting out its activation delay")]
    ChangeNotDue,
    #[msg("Only the admin or the guardian can do this")]
    NotGuardian,
    #[msg("Share tokens of this pool can never be collateral")]
    ShareMintNotCollateral,
    #[msg("This collateral is still in its activation delay")]
    NotYetActive,
    #[msg("The epoch length can only change once the yield buffer is paid out, or to 0")]
    EpochChangeNotAllowed,
    #[msg("A volatility sample needs a newer price")]
    VolTooSoon,
    #[msg("This needs an Orca market with the base token first")]
    UnsupportedDex,
    #[msg("The vault holds less than its books say, so it takes no deposits")]
    VaultShort,
    #[msg("This token's price is unclear around a corporate action, so it can't be seized yet")]
    PriceUnclear,
    #[msg("The account still owes debt")]
    DebtOutstanding,
    #[msg("Withdraw every position before closing the account")]
    CollateralLeft,
    #[msg("This senior exit was already cancelled")]
    ExitCancelled,
    #[msg("This needs a Raydium market")]
    NotRaydiumMarket,
}
