// Checks the raw account layouts and that whoever holds a position NFT can collect its fees
// Collects the fees of p1 and p2, so run orca:fixture again before the next orca:snapshot
import assert from "node:assert";
import type { Instruction } from "@orca-so/common-sdk";
import { IGNORE_CACHE, WhirlpoolIx, toTx } from "@orca-so/whirlpools-sdk";
import {
  ExtensionType,
  TOKEN_PROGRAM_ID,
  createAccount,
  createTransferCheckedInstruction,
  getExtensionTypes,
  getMint,
} from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { ataA, ataB, connection, ctx, describe, key, me, wallet, whirlpool } from "./orca-common.ts";

const state = await describe();
const read = async (a: PublicKey) => (await connection.getAccountInfo(a))!.data;
const u128 = (d: Buffer, o: number) => (d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n)).toString();
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
const balances = () =>
  Promise.all([ataA, ataB].map(async (t) => BigInt((await connection.getTokenAccountBalance(t)).value.amount)));
const simulate = async (ix: Instruction, signers: Keypair[]) => {
  const tx = new Transaction().add(...ix.instructions);
  tx.feePayer = me;
  return (await connection.simulateTransaction(tx, [wallet, ...signers])).value;
};
const units = async (signature: string) =>
  (await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 }))!.meta!.computeUnitsConsumed;

const w = await read(whirlpool);
assert.deepStrictEqual(
  {
    length: w.length,
    discriminator: w.subarray(0, 8).toString("hex"),
    tickSpacing: w.readUInt16LE(41),
    liquidity: u128(w, 49),
    sqrtPrice: u128(w, 65),
    tickCurrentIndex: w.readInt32LE(81),
    tokenMintA: pk(w, 101),
    tokenVaultA: pk(w, 133),
    tokenMintB: pk(w, 181),
    tokenVaultB: pk(w, 213),
    rewardLastUpdatedTimestamp: w.readBigUInt64LE(261).toString(),
  },
  {
    length: 653,
    discriminator: "3f95d10ce1806309",
    tickSpacing: state.tickSpacing,
    liquidity: state.liquidity,
    sqrtPrice: state.sqrtPrice,
    tickCurrentIndex: state.tickCurrentIndex,
    tokenMintA: state.tokenA.mint.toBase58(),
    tokenVaultA: state.tokenA.vault.toBase58(),
    tokenMintB: state.tokenB.mint.toBase58(),
    tokenVaultB: state.tokenB.vault.toBase58(),
    rewardLastUpdatedTimestamp: state.rewardLastUpdatedTimestamp,
  },
);
console.log("whirlpool raw offsets match the sdk decode");

const holder = key("holder");
const report = [];
// The classic NFT (p1) is collected with v1 and the Token-2022 one (p2) with v2
for (const [p, v2] of [
  [state.positions[0], false],
  [state.positions[1], true],
] as const) {
  const mint = await getMint(connection, p.positionMint, undefined, p.tokenProgram);
  // A plain token account, not an ATA, which is the weakest thing a PDA vault could be
  const held = await createAccount(
    connection,
    wallet,
    p.positionMint,
    holder.publicKey,
    Keypair.generate(),
    undefined,
    p.tokenProgram,
  );
  const move = (from: PublicKey, to: PublicKey, owner: Keypair) =>
    sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createTransferCheckedInstruction(from, p.positionMint, to, owner.publicKey, 1, 0, [], p.tokenProgram),
      ),
      [wallet, owner],
    );
  const transferUnits = await units(await move(p.ownerTokenAccount, held, wallet));

  const updateUnits = await units(
    await toTx(
      ctx,
      WhirlpoolIx.updateFeesAndRewardsIx(ctx.program, {
        whirlpool,
        position: p.position,
        tickArrayLower: p.tickArrayLower,
        tickArrayUpper: p.tickArrayUpper,
      }),
    ).buildAndExecute(),
  );
  const d = await read(p.position);
  const sdk = (await ctx.fetcher.getPosition(p.position, IGNORE_CACHE))!;
  assert.deepStrictEqual(
    {
      length: d.length,
      discriminator: d.subarray(0, 8).toString("hex"),
      whirlpool: pk(d, 8),
      positionMint: pk(d, 40),
      liquidity: u128(d, 72),
      tickLowerIndex: d.readInt32LE(88),
      tickUpperIndex: d.readInt32LE(92),
      feeOwedA: d.readBigUInt64LE(112).toString(),
      feeOwedB: d.readBigUInt64LE(136).toString(),
    },
    {
      length: 216,
      discriminator: "aabc8fe47a40f7d0",
      whirlpool: whirlpool.toBase58(),
      positionMint: p.positionMint.toBase58(),
      liquidity: p.liquidity,
      tickLowerIndex: p.tickLowerIndex,
      tickUpperIndex: p.tickUpperIndex,
      feeOwedA: p.uncollectedFeeA,
      feeOwedB: p.uncollectedFeeB,
    },
  );
  assert(sdk.feeOwedA.toString() === p.uncollectedFeeA && sdk.feeOwedB.toString() === p.uncollectedFeeB);

  const accounts = {
    whirlpool,
    position: p.position,
    positionTokenAccount: held,
    positionAuthority: holder.publicKey,
    tokenOwnerAccountA: ataA,
    tokenOwnerAccountB: ataB,
    tokenVaultA: state.tokenA.vault,
    tokenVaultB: state.tokenB.vault,
  };
  const mints = {
    tokenMintA: state.tokenA.mint,
    tokenMintB: state.tokenB.mint,
    tokenProgramA: TOKEN_PROGRAM_ID,
    tokenProgramB: TOKEN_PROGRAM_ID,
  };
  const decrease = {
    ...accounts,
    liquidityAmount: new BN(p.liquidity).divn(2),
    tokenMinA: new BN(0),
    tokenMinB: new BN(0),
    tickArrayLower: p.tickArrayLower,
    tickArrayUpper: p.tickArrayUpper,
  };
  const ixs = {
    collect_fees: WhirlpoolIx.collectFeesIx(ctx.program, accounts),
    collect_fees_v2: WhirlpoolIx.collectFeesV2Ix(ctx.program, { ...accounts, ...mints }),
    decrease_liquidity: WhirlpoolIx.decreaseLiquidityIx(ctx.program, decrease),
    decrease_liquidity_v2: WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, { ...decrease, ...mints }),
  };
  // Every variant is simulated with the holder signing, and only one collect is sent so liquidity stays put
  const computeUnits: Record<string, number | undefined> = {
    transfer_nft: transferUnits,
    update_fees_and_rewards: updateUnits,
  };
  for (const [name, ix] of Object.entries(ixs)) {
    const { err, unitsConsumed } = await simulate(ix, [holder]);
    assert(err === null, `${name} on ${p.name}: ${JSON.stringify(err)}`);
    computeUnits[name] = unitsConsumed;
  }
  // The wallet gave the NFT away, so it must be locked out
  const stale = WhirlpoolIx.collectFeesIx(ctx.program, { ...accounts, positionAuthority: me });
  assert((await simulate(stale, [])).err !== null, `${p.name}: previous owner can still collect`);

  const before = await balances();
  await toTx(ctx, v2 ? ixs.collect_fees_v2 : ixs.collect_fees).addSigner(holder).buildAndExecute();
  const after = await balances();
  assert.deepStrictEqual(
    [after[0] - before[0], after[1] - before[1]].map(String),
    [p.uncollectedFeeA, p.uncollectedFeeB],
  );

  await move(held, p.ownerTokenAccount, holder);
  report.push({
    position: p.name,
    nftTokenProgram: p.tokenProgram.toBase58(),
    mintExtensions: getExtensionTypes(mint.tlvData).map((e) => ExtensionType[e]),
    collectedWith: v2 ? "collect_fees_v2" : "collect_fees",
    collected: [p.uncollectedFeeA, p.uncollectedFeeB],
    computeUnits,
  });
}
console.log(JSON.stringify(report, null, 2));
