// QuickNode Streams filter for the Solana Block dataset: paste into the stream's filter editor
// Set the stream's batch size to 1 so that batch_start_range is the slot of the block being filtered
const PROGRAM_ID = "6Jipm4bxEr5mrvfQn6na12EkB1ALSyh7nk7hwybpQsny";

function main(stream) {
  const out = [];
  for (const block of stream.data) {
    if (!block || !block.transactions) continue;
    // A block does not carry its own slot, and in a larger batch the parent's slot plus one is the closest known value
    const slot = stream.data.length === 1 ? Number(stream.metadata.batch_start_range) : block.parentSlot + 1;
    for (const tx of block.transactions) {
      // Parsed blocks list accounts as objects, raw ones as plain strings
      const touched = tx.transaction.message.accountKeys.some((k) => (k.pubkey || k) === PROGRAM_ID);
      if (!touched) continue;
      out.push({
        signature: tx.transaction.signatures[0],
        slot,
        blockTime: block.blockTime,
        err: tx.meta ? tx.meta.err : null,
        logs: (tx.meta && tx.meta.logMessages) || [],
      });
    }
  }
  return out.length ? out : null;
}
