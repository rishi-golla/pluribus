import { seeded } from "./assets";

/** The hero's board: SIDE by SIDE cells shared out between the example portfolio's holdings */
export const SIDE = 32;
export const CELLS = SIDE * SIDE;

export const LIME = 0;
export const GRAY = 1;
export type CellState = typeof LIME | typeof GRAY;

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

// a fixed value per cell that changes slowly across the board, with a little grain on top,
// so dimmed cells gather in ragged patches like a heatmap and sit the same on server and browser
const NOISE: number[] = (() => {
  const rand = seeded(29);
  const STEP = 5;
  const n = Math.ceil(SIDE / STEP) + 2;
  const lattice = Array.from({ length: n * n }, () => rand());
  const ease = (t: number) => t * t * (3 - 2 * t);
  return Array.from({ length: CELLS }, (_, c) => {
    const [y, x] = [Math.floor(c / SIDE) / STEP, (c % SIDE) / STEP];
    const [y0, x0] = [Math.floor(y), Math.floor(x)];
    const [fy, fx] = [ease(y - y0), ease(x - x0)];
    const at = (r: number, k: number) => lattice[r * n + k];
    const v = at(y0, x0) * (1 - fx) * (1 - fy) + at(y0, x0 + 1) * fx * (1 - fy) + at(y0 + 1, x0) * (1 - fx) * fy + at(y0 + 1, x0 + 1) * fx * fy;
    return v * 6 + rand() * 1.6;
  });
})();

/**
 * What each cell shows. A gray channel one cell wide runs along every border, so no two holdings' green cells touch,
 * not even at a corner. Past that, `dim[i]` is roughly the share of region i drawn gray, 0 to 1: the rest of it
 * reaches inward from the borders where the noise is low. Each holding's green is then tidied into one solid island.
 */
export function cellStates(owner: number[], dim: number[]): CellState[] {
  const depth = depths(owner, false);
  const states = new Array<CellState>(CELLS).fill(LIME);
  // the channel is cut from one side only, the later holding's, and looks at all eight neighbours to close corners
  for (let c = 0; c < CELLS; c++) {
    const [r, k] = [Math.floor(c / SIDE), c % SIDE];
    for (let dr = -1; dr <= 1 && states[c] === LIME; dr++)
      for (let dk = -1; dk <= 1; dk++) {
        const [rr, kk] = [r + dr, k + dk];
        if (rr < 0 || kk < 0 || rr >= SIDE || kk >= SIDE || owner[rr * SIDE + kk] >= owner[c]) continue;
        states[c] = GRAY;
        break;
      }
  }
  const byRegion: number[][] = dim.map(() => []);
  owner.forEach((o, c) => byRegion[o].push(c));
  byRegion.forEach((cells, i) => {
    const green = cells.filter((c) => states[c] === LIME).sort((a, b) => depth[a] + NOISE[a] - (depth[b] + NOISE[b]));
    const more = Math.round(cells.length * dim[i]) - (cells.length - green.length);
    for (let j = 0; j < more; j++) states[green[j]] = GRAY;
  });

  // one island per holding: green cells cut off from the holding's largest green piece go gray
  const piece = new Int32Array(CELLS).fill(-1);
  const sizes: number[] = [];
  const best: number[] = dim.map(() => -1);
  for (let c = 0; c < CELLS; c++) {
    if (states[c] !== LIME || piece[c] >= 0) continue;
    const id = sizes.length;
    const stack = [c];
    piece[c] = id;
    let size = 0;
    while (stack.length) {
      const x = stack.pop()!;
      size++;
      for (const n of NB[x]) {
        if (states[n] !== LIME || owner[n] !== owner[c] || piece[n] >= 0) continue;
        piece[n] = id;
        stack.push(n);
      }
    }
    sizes.push(size);
    if (best[owner[c]] < 0 || size > sizes[best[owner[c]]]) best[owner[c]] = id;
  }
  for (let c = 0; c < CELLS; c++) if (states[c] === LIME && piece[c] !== best[owner[c]]) states[c] = GRAY;

  // no holes: gray that cannot be reached from a border between holdings through other gray is a hole in the green, and goes green
  const open = new Uint8Array(CELLS);
  const stack: number[] = [];
  for (let c = 0; c < CELLS; c++) {
    if (states[c] !== GRAY || depth[c] !== 0) continue;
    open[c] = 1;
    stack.push(c);
  }
  while (stack.length)
    for (const n of NB[stack.pop()!]) {
      if (states[n] !== GRAY || open[n]) continue;
      open[n] = 1;
      stack.push(n);
    }
  for (let c = 0; c < CELLS; c++) if (states[c] === GRAY && !open[c]) states[c] = LIME;
  return states;
}

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
