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

/** A round axis maximum at or above `v` that splits into four even steps */
export function niceMax(v: number) {
  if (!(v > 0)) return 4;
  const step = 10 ** Math.floor(Math.log10(v / 4));
  const m = v / 4 / step;
  return 4 * step * (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10);
}

const DAY_MS = 86_400_000;

/** Timed readings inside the last `days`, padded to the two points a line needs */
export function inRange<T extends { at: number }>(samples: T[], days: number) {
  const kept = samples.filter((s) => s.at >= samples[samples.length - 1].at - days * DAY_MS);
  return kept.length > 1 ? kept : [kept[0], kept[0]];
}
export const timeLabel = (at: number, seconds = false) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(seconds && { second: "2-digit" }) });
/** Seven evenly spaced time labels, with seconds while the readings span only a few minutes */
export const axisTimes = (samples: { at: number }[]) =>
  Array.from({ length: 7 }, (_, k) => timeLabel(samples[Math.round((k / 6) * (samples.length - 1))].at, samples[samples.length - 1].at - samples[0].at < 7 * 60_000));
