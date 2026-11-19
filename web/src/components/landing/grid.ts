import { seeded } from "./assets";

/** The hero's board: SIDE by SIDE cells shared out between the example portfolio's holdings */
export const SIDE = 32;
export const CELLS = SIDE * SIDE;

export const LIME = 0;
export const GRAY = 1;
export type CellState = typeof LIME | typeof GRAY;

/**
 * Where a holding sits on the board and how hard it pushes. A larger `weight` wins it more cells from its neighbours.
 * `band` is how far its gray edge reaches in from a border, in cells.
 */
export type Site = { x: number; y: number; weight: number; band: number };

export type Layout = {
  owner: number[];
  states: CellState[];
  /** cells each holding owns, green and gray together */
  counts: number[];
  /** the middle of each holding's green, in cells from the board's top left */
  centers: [number, number][];
};

// A fixed value per cell, 0 to 1, that changes slowly across the board. It varies the width of the gray bands, so their
// edges wander instead of running dead straight. Seeded, so it is the same on the server and in the browser.
const ROUGH: number[] = (() => {
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
    return at(y0, x0) * (1 - fx) * (1 - fy) + at(y0, x0 + 1) * fx * (1 - fy) + at(y0 + 1, x0) * (1 - fx) * fy + at(y0 + 1, x0 + 1) * fx * fy;
  });
})();

/**
 * Shares the board out as a power diagram: a cell goes to the site whose squared distance, less its weight, is smallest.
 * The borders are then straight lines, and they slide smoothly as sites and weights change. That is why the motion
 * reads as holdings pushing at each other: moving single cells along the borders, which came first, only made them flicker.
 *
 * A cell closer to a border than its holding's band is gray. The band never narrows below three quarters of a cell,
 * which is enough that green cells of two holdings cannot touch, even at a corner.
 */
export function layout(sites: Site[]): Layout {
  const n = sites.length;
  const owner = new Array<number>(CELLS);
  const states = new Array<CellState>(CELLS);
  const counts = new Array<number>(n).fill(0);
  const sums = sites.map(() => [0, 0, 0]);
  const reach = new Array<number>(n);
  for (let c = 0; c < CELLS; c++) {
    const [px, py] = [(c % SIDE) + 0.5, Math.floor(c / SIDE) + 0.5];
    let best = 0;
    for (let i = 0; i < n; i++) {
      reach[i] = (px - sites[i].x) ** 2 + (py - sites[i].y) ** 2 - sites[i].weight;
      if (reach[i] < reach[best]) best = i;
    }
    // how far the cell is from the nearest border of its region, in cells
    let edge = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === best) continue;
      const d = (reach[j] - reach[best]) / (2 * Math.hypot(sites[j].x - sites[best].x, sites[j].y - sites[best].y));
      if (d < edge) edge = d;
    }
    const gray = edge < Math.max(0.75, sites[best].band * (0.7 + 0.6 * ROUGH[c]));
    owner[c] = best;
    states[c] = gray ? GRAY : LIME;
    counts[best]++;
    if (gray) continue;
    sums[best][0] += px;
    sums[best][1] += py;
    sums[best][2]++;
  }

  // A region squeezed thin can have its green pinched in two by the band. Only the largest piece stays green, so a
  // holding is always one island; the stray piece would otherwise blink in and out as the border moves.
  const piece = new Int32Array(CELLS).fill(-1);
  const sizes: number[] = [];
  const largest = new Array<number>(n).fill(-1);
  for (let c = 0; c < CELLS; c++) {
    if (states[c] !== LIME || piece[c] >= 0) continue;
    const id = sizes.length;
    const stack = [c];
    piece[c] = id;
    let size = 0;
    while (stack.length) {
      const x = stack.pop()!;
      size++;
      const [r, k] = [Math.floor(x / SIDE), x % SIDE];
      for (const m of [r > 0 ? x - SIDE : -1, r < SIDE - 1 ? x + SIDE : -1, k > 0 ? x - 1 : -1, k < SIDE - 1 ? x + 1 : -1]) {
        if (m < 0 || states[m] !== LIME || owner[m] !== owner[c] || piece[m] >= 0) continue;
        piece[m] = id;
        stack.push(m);
      }
    }
    sizes.push(size);
    if (largest[owner[c]] < 0 || size > sizes[largest[owner[c]]]) largest[owner[c]] = id;
  }
  for (let c = 0; c < CELLS; c++) {
    if (states[c] !== LIME || piece[c] === largest[owner[c]]) continue;
    states[c] = GRAY;
    sums[owner[c]][0] -= (c % SIDE) + 0.5;
    sums[owner[c]][1] -= Math.floor(c / SIDE) + 0.5;
    sums[owner[c]][2]--;
  }
  const centers = sums.map(([x, y, m], i): [number, number] => (m ? [x / m, y / m] : [sites[i].x, sites[i].y]));
  return { owner, states, counts, centers };
}

/** Sets the sites' weights so each holding owns about its share of the board; `shares` add up to 1 */
export function balance(sites: Site[], shares: number[]): Site[] {
  const out = sites.map((s) => ({ ...s }));
  // a region that is short of cells pushes harder, one that has too many eases off, until they settle
  for (let pass = 0; pass < 300; pass++) {
    const { counts } = layout(out);
    out.forEach((s, i) => (s.weight += 0.4 * (shares[i] * CELLS - counts[i])));
  }
  return out;
}
