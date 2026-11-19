import { seeded } from "./assets";

/** The hero's board: SIDE by SIDE cells shared out between the example portfolio's holdings */
export const SIDE = 20;
export const CELLS = SIDE * SIDE;

export const LIME = 0;
export const BUFFER = 1;
export const LOST = 2;
export type CellState = typeof LIME | typeof BUFFER | typeof LOST;

const NB: number[][] = Array.from({ length: CELLS }, (_, c) => {
  const [r, k] = [Math.floor(c / SIDE), c % SIDE];
  return [r > 0 && c - SIDE, r < SIDE - 1 && c + SIDE, k > 0 && c - 1, k < SIDE - 1 && c + 1].filter((n): n is number => n !== false);
});

/** Cell counts in proportion to `values` that fill the board exactly, by largest remainder */
export function quotas(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  const raw = values.map((v) => (total > 0 ? (v / total) * CELLS : CELLS / values.length));
  const out = raw.map(Math.floor);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let left = CELLS - out.reduce((a, b) => a + b, 0), j = 0; left > 0; left--, j++) out[order[j % order.length][1]]++;
  return out;
}

const countAll = (owner: number[], n: number) => {
  const counts = new Array<number>(n).fill(0);
  for (const o of owner) counts[o]++;
  return counts;
};

// whether taking `c` out of its region would cut the region in two; the region is connected before
function splits(owner: number[], c: number): boolean {
  const a = owner[c];
  const same = NB[c].filter((n) => owner[n] === a);
  if (same.length <= 1) return false;
  const seen = new Set([c, same[0]]);
  const stack = [same[0]];
  while (stack.length) {
    for (const n of NB[stack.pop()!]) {
      if (owner[n] !== a || seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return same.some((n) => !seen.has(n));
}

/**
 * Moves up to `maxMoves` border cells from regions over their quota to neighbours under theirs,
 * picking cells that smooth the border and never splitting a region. Returns the moves made.
 */
export function settle(owner: number[], target: number[], rand: () => number, maxMoves: number): number {
  const counts = countAll(owner, target.length);
  let moves = 0;
  while (moves < maxMoves) {
    let [best, cell, to] = [-Infinity, -1, -1];
    for (let c = 0; c < CELLS; c++) {
      const a = owner[c];
      const surplus = counts[a] - target[a];
      if (counts[a] <= 1) continue;
      for (const n of NB[c]) {
        const b = owner[n];
        // a move only helps when the giver is at least two cells better off than the taker
        const gap = surplus - (counts[b] - target[b]);
        if (b === a || gap < 2) continue;
        let edge = 0;
        for (const x of NB[c]) edge += owner[x] === b ? 1 : owner[x] === a ? -1 : 0;
        const score = gap * 10 + edge + rand() * 0.5;
        if (score > best && !splits(owner, c)) [best, cell, to] = [score, c, b];
      }
    }
    if (cell < 0) break;
    counts[owner[cell]]--;
    counts[to]++;
    owner[cell] = to;
    moves++;
  }
  return moves;
}

// hands every piece of a region other than its largest to a neighbouring region, so each region is one piece
function joinPieces(owner: number[], n: number) {
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let a = 0; a < n; a++) {
      const pieces: number[][] = [];
      const seen = new Set<number>();
      for (let c = 0; c < CELLS; c++) {
        if (owner[c] !== a || seen.has(c)) continue;
        const piece = [c];
        seen.add(c);
        for (let i = 0; i < piece.length; i++)
          for (const x of NB[piece[i]]) {
            if (owner[x] !== a || seen.has(x)) continue;
            seen.add(x);
            piece.push(x);
          }
        pieces.push(piece);
      }
      pieces.sort((p, q) => q.length - p.length);
      for (const piece of pieces.slice(1))
        for (const c of piece) {
          const other = NB[c].find((x) => owner[x] !== a);
          if (other === undefined) continue;
          owner[c] = owner[other];
          moved = true;
        }
    }
    if (!moved) return;
  }
}

/** A starting board: each holding grows from its seed cell, larger holdings reaching further, then counts are made exact */
export function initialOwners(seeds: readonly (readonly [number, number])[], values: number[]): number[] {
  const target = quotas(values);
  const owner = Array.from({ length: CELLS }, (_, c) => {
    const [r, k] = [Math.floor(c / SIDE), c % SIDE];
    let [best, pick] = [Infinity, 0];
    seeds.forEach(([sk, sr], i) => {
      const d = Math.hypot(k - sk, r - sr) / Math.sqrt(target[i]);
      if (d < best) [best, pick] = [d, i];
    });
    return pick;
  });
  joinPieces(owner, seeds.length);
  settle(owner, target, seeded(11), CELLS);
  return owner;
}

/** A fixed jitter per cell, so the crash eats into borders unevenly and the same way on server and browser */
export const JITTER: number[] = (() => {
  const rand = seeded(29);
  return Array.from({ length: CELLS }, () => rand() * 1.6);
})();

// steps from each cell to the nearest cell of another region; `edges` counts the board's edge as a border too
function depths(owner: number[], edges: boolean): number[] {
  const depth = new Array<number>(CELLS).fill(Infinity);
  const queue: number[] = [];
  for (let c = 0; c < CELLS; c++) {
    const onEdge = edges && NB[c].length < 4;
    if (!onEdge && NB[c].every((n) => owner[n] === owner[c])) continue;
    depth[c] = 0;
    queue.push(c);
  }
  for (let i = 0; i < queue.length; i++)
    for (const n of NB[queue[i]]) {
      if (owner[n] !== owner[queue[i]] || depth[n] !== Infinity) continue;
      depth[n] = depth[queue[i]] + 1;
      queue.push(n);
    }
  return depth;
}

/**
 * What each cell shows: per region, `lost[i]` and `buffer[i]` are the shares of its value a crash takes
 * and the cushion above the liquidation line, 0 to 1. The crash eats in from the region's borders.
 */
export function cellStates(owner: number[], lost: number[], buffer: number[]): CellState[] {
  const depth = depths(owner, false);
  const byRegion: number[][] = lost.map(() => []);
  owner.forEach((o, c) => byRegion[o].push(c));
  const states = new Array<CellState>(CELLS).fill(LIME);
  byRegion.forEach((cells, i) => {
    cells.sort((x, y) => depth[x] + JITTER[x] - (depth[y] + JITTER[y]));
    const nLost = Math.round(cells.length * lost[i]);
    const nBuffer = Math.round(cells.length * buffer[i]);
    cells.forEach((c, j) => (states[c] = j < nLost ? LOST : j < nLost + nBuffer ? BUFFER : LIME));
  });
  return states;
}

/** The cell deepest inside each region, for its label; keeps `prev` unless it left the region or a clearly deeper cell exists */
export function labelCells(owner: number[], n: number, prev?: number[]): number[] {
  const depth = depths(owner, true);
  return Array.from({ length: n }, (_, i) => {
    let [best, pick, sr, sk, m] = [-Infinity, -1, 0, 0, 0];
    owner.forEach((o, c) => {
      if (o !== i) return;
      sr += Math.floor(c / SIDE);
      sk += c % SIDE;
      m++;
    });
    const [cr, ck] = [sr / Math.max(m, 1), sk / Math.max(m, 1)];
    owner.forEach((o, c) => {
      if (o !== i) return;
      // deeper wins; among equals, closer to the region's middle
      const score = depth[c] * 100 - Math.hypot(Math.floor(c / SIDE) - cr, (c % SIDE) - ck);
      if (score > best) [best, pick] = [score, c];
    });
    const p = prev?.[i];
    return p !== undefined && owner[p] === i && depth[p] >= depth[pick] - 1 ? p : pick;
  });
}

/** Line segments along every edge between two regions, in cell units, as an SVG path */
export function borderPath(owner: number[]): string {
  let d = "";
  for (let c = 0; c < CELLS; c++) {
    const [r, k] = [Math.floor(c / SIDE), c % SIDE];
    if (k < SIDE - 1 && owner[c + 1] !== owner[c]) d += `M${k + 1} ${r}v1`;
    if (r < SIDE - 1 && owner[c + SIDE] !== owner[c]) d += `M${k} ${r + 1}h1`;
  }
  return d;
}
