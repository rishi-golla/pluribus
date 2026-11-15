export type Point = [number, number];

/** Deterministic pseudo-random walk from `start` to `end` (Park-Miller LCG), so SSR output is stable. */
export function series(n: number, start: number, end: number, vol: number, seed = 1): number[] {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
  const out: number[] = [];
  let drift = 0;
  for (let i = 0; i < n; i++) {
    drift = drift * 0.82 + rnd() * vol;
    out.push(start + ((end - start) * i) / (n - 1) + drift);
  }
  out[n - 1] = end;
  return out;
}

/** Catmull-Rom style smoothing into cubic Bezier segments. */
export function smoothPath(pts: Point[], t = 0.18): string {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) * t},${p1[1] + (p2[1] - p0[1]) * t} ${p2[0] - (p3[0] - p1[0]) * t},${p2[1] - (p3[1] - p1[1]) * t} ${p2[0]},${p2[1]}`;
  }
  return d;
}
