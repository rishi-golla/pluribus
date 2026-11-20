# Meteora DLMM positions as collateral

Research, design and what is built. Everything stated as fact below was read from the deployed program, its IDL or mainnet accounts, or measured by `programs/pluribus/tests/dlmm.rs` against the mainnet binary in LiteSVM.

## Recommendation

- **Custody:** the pool PDA is the owner of the position from its first instruction. A DLMM position cannot change owner, so a position a wallet already holds cannot be brought in; the user opens a new one through Pluribus and moves liquidity into it.
- **Valuation:** from the position's own liquidity shares, the bin prices and the oracle price only. Each bin counts as whichever of its two tokens is worth less at that price. The pair's active bin, its bin arrays and its reserves are never read, so a swap cannot move the value.
- **Liquidation:** the pool PDA removes the liquidated share of every bin by CPI straight into the liquidator's token accounts. Unlike an NFT a position can be sold in part.
- **Fees:** `claim_fee2` by CPI into the protocol's own vaults, then the same split as Orca autopay.
- **Listing:** a DLMM pair is an `LpMarket` like any other, listed with `init_lp_market`, so pause, cost, timelock and guardian work unchanged.

All of it is implemented in the program and tested, with SDK builders, a keeper and a web UI on top (see the end).

## Sources

| What | Where |
|---|---|
| Program | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`, upgradeable, authority `JADaUV8k…CVLd`, last deployed in slot 423977638 |
| Binary | dumped from mainnet, 2,229,776 bytes, sha256 `d296c677…77844c1f`. `npm run dlmm:snapshot` fetches it again |
| IDL | `idls/dlmm.json` v0.12.0 in `MeteoraAg/dlmm-sdk` at `1532e54`. All 75 of its instruction discriminators are in the mainnet binary |
| Source | the program left the public repo in `ffec306`; the last public copy (`c2c4c8d`, March 2025) has the state and math but empty handlers |
| Accounts | three mainnet SOL/USDC pairs (bin steps 1, 4, 10), 1,890 of their bins, positions of the 4 bps pair |

The newer program is closed source. Layouts, discriminators and behaviour below were confirmed on mainnet data and in tests, but the instruction handlers themselves could not be read.

## Account layouts

Zero-copy, `repr(C)`, little-endian, after the 8-byte discriminator. Offsets are from the start of the account.

**PositionV2** (`75 b0 d4 c7 f5 b4 85 b6`, 8,120 bytes)

| Offset | Field | Notes |
|---|---|---|
| 8 | `lb_pair` | |
| 40 | `owner` | set at creation, no instruction changes it |
| 72 | `liquidity_shares: [u128; 70]` | one per bin from `lower_bin_id`, Q64.64 |
| 1192 | `reward_infos: [UserRewardInfo; 70]` | 48 bytes each |
| 4552 | `fee_infos: [FeeInfo; 70]` | 48 bytes each: two per-share checkpoints, pending X and Y |
| 7912 | `lower_bin_id: i32`, `upper_bin_id: i32` at 7916 | inclusive |
| 7920 | `last_updated_at`, claimed fee and reward totals | |
| 7960 | `operator` | all zero on every ordinary position |
| 7992 | `lock_release_point: u64` | liquidity cannot leave before it |
| 8001 | `fee_owner` | only for launch positions |
| 8033 | `version`, `permissionless_operation_bits` at 8034 | the bits let anyone trigger a fee claim |

A position starts at 70 bins. `increase_position_length` can grow it to 1,400 by appending to the account, which only the owner can do.

**LbPair** (`21 0b 31 62 b5 65 b1 0d`, 904 bytes)

| Offset | Field |
|---|---|
| 8 | `StaticParameters` (32): base factor, fee settings, min and max bin id, `function_type` at 35 (2 = limit orders), `collect_fee_mode` at 36 |
| 40 | `VariableParameters` (32): volatility accumulator and reference |
| 76 | `active_id: i32` |
| 80 | `bin_step: u16` in bps, 1 to 400 |
| 82 | `status: u8`, 0 enabled |
| 88 | `token_x_mint`, `token_y_mint` at 120 |
| 152 | `reserve_x`, `reserve_y` at 184 (token accounts at PDA `[pair, mint]`) |
| 264 | `reward_infos: [RewardInfo; 2]`, 144 bytes each, mint first |
| 552 | `oracle` (PDA `["oracle", pair]`), then the bin array bitmap |
| 880 | `token_mint_x_program_flag`, `token_mint_y_program_flag` at 881 (0 classic, 1 Token-2022) |

**BinArray** (`5c 8e 5c dc 05 94 46 b5`, 10,136 bytes, PDA `["bin_array", pair, index as i64]`): `index: i64` at 8, `lb_pair` at 24, then 70 bins of 144 bytes from 56. Array `i` holds bins `70 i` to `70 i + 69`.

**Bin**: `amount_x: u64`, `amount_y: u64`, `price: u128` (Q64.64, token Y base units per token X base unit), `liquidity_supply: u128`, then fee-per-share accumulators and the limit-order fields.

Bin price is `(1 + bin_step / 10000) ^ bin_id`. `dlmm::bin_price` is DLMM's own routine: a port of it matched the stored price of all 1,890 bins checked, and the Rust is unit-tested against three of them.

## Custody

| Route | Verdict |
|---|---|
| Transfer the position | Impossible. No instruction changes `owner`: the IDL has none, and no likely name for one has its discriminator in the binary |
| User stays owner, pool is `operator` | Unsafe. The owner can still remove everything, and nothing locks it |
| `initialize_position_by_operator` | A launch-pool path that takes the owner unsigned and sets a lock and a fee owner. Never used here, and the health check rejects what it produces |
| Pool PDA is owner, created by CPI | **Chosen.** `initialize_position2` takes the owner as a signer, which a PDA can be |

Measured against the mainnet binary:

- `initialize_position2` by CPI with the pool PDA as owner makes an 8,120-byte position with a zero operator, no lock and no fee owner.
- Removing liquidity, collecting fees, `close_position2` and `close_position_if_empty` sent straight to DLMM by the borrower or by a stranger all fail on the position's owner-or-operator constraint.
- The owner removes to any token account. That is how liquidity reaches the borrower or a liquidator without passing through a pool vault.
- A pair Meteora has disabled refuses new liquidity (`PoolDisabled`) but still lets it out, fees included. A disabled pair does not strand a liquidator.
- A position with uncollected fees does not close (`NonEmptyPosition`), so fees are collected first.

**Adding liquidity.** DLMM takes the tokens from whoever signs, and only the owner or operator may add. `dlmm_add` therefore makes the borrower operator, lets DLMM debit the borrower's own token accounts with the borrower's signature, and clears the operator again, all in one instruction. The alternative, routing tokens through pool-owned transit accounts, was rejected: with the operator hand-off **the pool PDA never signs an instruction that debits a token account**. It signs only ones that pay out of the pair (remove, claim), close a position or set its operator.

**What the health check requires of a position every time:** owned by the DLMM program, the `PositionV2` discriminator, exactly 8,120 bytes, `owner` the pool PDA, zero `operator`, zero `lock_release_point`, zero `fee_owner`, at most 70 bins, in the pair its market lists. A slot can only be written by `dlmm_open`, which creates the position itself, so these hold by construction; they are checked anyway because a failed check blocks rather than misvalues.

## Valuation

A bin trades at one fixed price `P` and keeps `L = P·x + y` constant. Its liquidity shares are claims on `L`: the first deposit mints `L` shares, later ones mint pro rata, and every deposit, withdrawal and swap rounds in the bin's favour. So

> a position's share `s` in a bin is backed by at least `s` of liquidity: `P·x + y ≥ s`, where `(x, y)` is what `s` withdraws.

On mainnet the ratio `L / supply` was never under 1 in 1,890 bins and at most 1.004; the excess is composition fees and rounding left in the bin.

What a swap can change is the mix `(x, y)`, never `L`. At an oracle price `q` (token Y per token X) the mix is worth `q·x + y`, and over every mix with `P·x + y = s` that is least at one end:

```
value of a bin ≥ s · min(1, q / P)      all token Y when P ≤ q, all token X when P > q
```

That floor is also exactly what the bin holds once arbitrage has traded the pair to `q`. So the value is the same as for a CLMM position in spirit (liquidity and range at an oracle price), with the difference that it is a lower bound whatever state the pair is in, not only an equilibrium value.

Under a scenario that also marks USDC down by `u`, the least-valuable mix flips where `q / P = 1 − u`, so the line between "counted as USDC" and "counted as base token" moves by that factor. A bin is never counted as base tokens worth more than its marked-down USDC.

`dlmm::Curve` does this once per health check: one pass over the shares builds running sums of token Y below and of shares discounted to each bin's price above, and each scenario is then a binary search and one division. With USDC as token X the same sums are read the other way round.

| | |
|---|---|
| Read | the position account, the pair account (for `bin_step` only), the base asset and its oracle price |
| Never read | `active_id`, bin arrays, reserves, the pair's own oracle |
| Left out, in the borrower's disfavour | uncollected fees; the up to 0.4% of extra liquidity behind each share; one base unit of each token per bin for withdrawal rounding |
| Tested | value ≤ real payout at five oracle prices; within 0.5% of it at the pair's own price; unchanged to the unit after swaps that move the active bin over ten bins each way |

Reading bin arrays to credit the real `L / supply` would add up to two 10 KB accounts per position per health check to recover at most 0.4%. Not worth it.

## Instructions

| Instruction | Who | What |
|---|---|---|
| `init_lp_market` (existing) | admin | Lists a pair. Refused unless both mints are classic tokens, the pair is enabled, is not a limit-order pair and has no farming rewards |
| `dlmm_open(lower_bin_id, width)` | owner | CPI `initialize_position2` with the pool PDA as owner; books a `KIND_DLMM` slot named by the position account. `width` 1 to 70. The owner pays the rent |
| `dlmm_add(amount_x, amount_y, active_id, max_active_bin_slippage, strategy)` | owner | CPI `add_liquidity_by_strategy2` over the whole range, with the operator hand-off above |
| `dlmm_remove(bps, bin_arrays)` | owner | CPI `remove_liquidity_by_range2` to the owner's token accounts, then the health check |
| `dlmm_close(bin_arrays)` | owner | CPI `claim_fee2` and `close_position2`: fees and rent to the owner, slot freed, then the health check |
| `dlmm_liquidate(repay_amount, bin_arrays)` | anyone | Below |
| `dlmm_autopay` | anyone | CPI `claim_fee2` into the base and USDC collateral vaults; the caller's recipient takes the bounty, the USDC left repays debt and the rest is booked as collateral |

Bin arrays come first in the remaining accounts, health accounts after. A health check takes five accounts per position: LP market, pair, position, base asset, base price.

## Liquidation

`dlmm_liquidate` works like the token liquidation, not the NFT one:

- `part = min(repay × (1 + bonus) / value, 100%)` in bps, with `repay` capped by the close factor, and the liquidator is charged `value × part / (1 + bonus)` rounded up.
- The health margin must not shrink, with the position's scenario values scaled by what stays.
- The pool PDA removes `part` of every bin into the liquidator's token accounts.
- At 100% the uncollected fees go with it, as they do with an LP NFT, the position is closed, its rent returns to the borrower and the slot is freed.
- A position valued at nothing goes whole for no payment, so an empty slot cannot keep bad debt from being written off. With no bin arrays named nothing is removed, which is how a position that never held liquidity is closed.

The liquidator receives the pair's real mix, which at the oracle price is worth at least what was valued. While the pair lags the oracle that is more than the bonus; it is the same profit anyone could take by trading the pair to the oracle price.

## Compute units

Measured on the mainnet binary, 70-bin positions.

| | Units |
|---|---|
| Health check, per position (inside a draw) | about 41,000, against about 24,500 for an Orca or Raydium position |
| Draw with 1 / 3 / 4 / 5 positions | 71k / 154k / 195k / 237k |
| `dlmm_add` over 70 bins | 456k |
| `dlmm_remove` of everything | 326k |
| `dlmm_close` with fees | 101k |
| `dlmm_liquidate` in part / whole | 381k / 498k |
| `dlmm_autopay` | 178k |

Every DLMM instruction needs a raised compute limit, and so does any health check on an account with five such positions. Most of the cost is inside DLMM, which walks every bin. Narrower positions cost proportionally less. The program grew from 1.05 MB to 1.20 MB.

## Risks

- **The program is upgradeable and closed source.** An upgrade can move a field, change who may act on a position, or stop a removal. Recheck the offsets in `dlmm.rs` and rerun `tests/dlmm.rs` on a fresh `npm run dlmm:snapshot` after every DLMM deploy. The health check fails closed on a changed position layout, and reads the pair's bin step only while it agrees with the copy the pair keeps as its address seed, but a change it cannot see would misprice. An account whose health check fails cannot be liquidated until that is fixed.
- **The pool PDA signs CPIs into DLMM.** It is also the authority of every vault. Today no instruction it signs debits a signer's token account, and the program id is pinned, but an upgraded DLMM could abuse that signature. The Orca autopay CPI carries the same trust.
- **The share bound was checked, not proven.** It follows from the last public source and held in every bin sampled. Limit-order pairs keep more state in their bins and are refused at listing for that reason; `function_type` could be changed on an existing pair by an upgrade.
- **Farming rewards.** Pairs with a reward are refused at listing because pending rewards might block `close_position2`, which the whole-position liquidation needs. Meteora's admin can add a reward later. A liquidator can then still take 99.99%.
- **A position cannot be moved in.** Users must open a new position and re-add liquidity, paying Meteora's composition fee if they add into the active bin.
- **Bin arrays must exist.** `dlmm_add` needs the range's bin arrays initialised, which anyone can do on DLMM directly at their own cost.
- **Transaction size.** A liquidation names about 24 accounts with one position and more with others; like the other liquidations it needs the lookup table.
- **Very large sides overflow**, as for the other LP kinds: a side over u64 base units, or a product past u128 when it is priced, fails the health check with `MathOverflow`.
- **Rent.** An 8,120-byte position's rent stays locked until it is closed, and returns to the borrower even after a liquidation.

## Not implemented

- Positions wider than 70 bins, Token-2022 pairs, and collecting farming rewards.

## Off chain and devnet

- **SDK:** `sdk/dlmm.ts` reads pairs and positions; `locateLps` and `healthAccounts` list a position's five health accounts; `fetchPositions` values it bin by bin, mirrored by `math.dlmmValue`, which matched the program's health view to the cent on devnet. `ix.dlmmOpen/Add/Remove/Close/Liquidate/Autopay` build the instructions with raised compute limits; `dlmmAdd` creates missing bin arrays and wraps SOL.
- **Web:** on the Borrow page, **Deposit** lists each listed pair as a new Meteora position and each held position as an add-liquidity option. The form follows Meteora's own Create Position panel: SOL and USDC amounts with Auto-Fill, the Spot, Curve or Bid Ask strategy (`SPOT`, `CURVE`, `BID_ASK`, Meteora's imbalanced strategies 6 to 8), the liquidity the deposit lays out bin by bin, a two-handle range slider over the pair's own liquidity (read from its bin arrays with `decodeBinArray`) up to 69 bins either side of the active one, min and max price boxes, and the rent the position and any new bin arrays cost. A position's row has **Add**, **Withdraw** (any percentage) and, once empty, **Close**. A paused, not yet active or Meteora-disabled pair is greyed out for new money and still lets liquidity out. Opening and funding a position is one transaction (`ix.dlmmOpenAndAdd`, which hands `dlmmAdd` the new position's pair and bins instead of reading them): 70 bins together with a first credit account came to 700 bytes and 432k compute units on devnet. The new position's keypair signs next to the wallet (`sendInstructions` takes extra signers).
- **Keeper:** sells Meteora positions in part through `dlmm_liquidate`. Their fees are left to bounty callers, which `compound.findHarvestable` finds by simulating `dlmm_autopay` or `compound_dlmm`.
- **Devnet:** DLMM has the same program id there but an older build (2,198,048 bytes, slot 466305525) and its own upgrade authority. All 13 tests pass against it (`DLMM_SO=lb_clmm_devnet.so`). `npm run dlmm:market` created the SOL/mock-USDC pair `Em4nQAHyFnCpm4FoofwqUX7KLcFvaZac42HXybVmnNHi` from the 10 bps preset and listed it; open, add, draw, remove, autopay, repay and close were run there. Measured: `dlmm_add` over 30 bins 206k units, removal 213k–239k, close 119k, autopay 123k; every transaction fits through the lookup table.
