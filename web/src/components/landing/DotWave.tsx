"use client";

import { useEffect, useRef } from "react";
import { seeded } from "./assets";

// The hero field's spacing and colors, so a wave reads as part of the same grid
const GAP = 24;
const WEIGHTS = [0.34, 0.28, 0.22, 0.16];
const VARS = ["--color-brand", "--color-blue", "--color-green", "--color-t2"];

type Props = {
  className?: string;
  /** Changes the wave's shape and colors, so two waves on one page don't match */
  seed?: number;
  /** How far the wave swings up and down, in pixels */
  amplitude?: number;
  /** Half the band's thickness at its widest, in pixels */
  thickness?: number;
  /** Which way the wave travels: 1 to the right, -1 to the left */
  dir?: 1 | -1;
};

/**
 * A thin ribbon of grid dots that curves across the full width and slowly flows sideways.
 * The dots stay on the grid and only light up where the ribbon passes, as quietly as the hero's field
 */
export function DotWave({ className, seed = 1, amplitude = 60, thickness = 132, dir = 1 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const css = getComputedStyle(document.documentElement);
    const colors = VARS.map((v) => css.getPropertyValue(v).trim() || "#9e8cff");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shape = seeded(seed * 9973);
    const [p1, p2, p3] = [shape() * 6.28, shape() * 6.28, shape() * 6.28];
    const wavelength = 900 + shape() * 500;
    let w = 0;
    let h = 0;

    type Dot = { color: string; base: number; block: boolean; phase: number };
    let grid: Dot[][] = [];
    let offset = 0;

    const layout = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cols = Math.ceil(w / GAP) + 1;
      const rows = Math.ceil(h / GAP) + 1;
      offset = (w % GAP) / 2;
      grid = Array.from({ length: cols }, (_, c) =>
        Array.from({ length: rows }, (_, r) => {
          const rand = seeded(seed * 31 + r * 7919 + (c - Math.floor(cols / 2)) * 104729);
          const pick = rand();
          let k = 0;
          for (let acc = WEIGHTS[0]; pick > acc && k < WEIGHTS.length - 1; acc += WEIGHTS[++k]);
          const block = rand() < 0.012;
          // About as bright as the hero's dots, which run at 40% of the full field
          return { color: colors[k], base: block ? 0.22 : 0.06 + rand() * 0.09, block, phase: rand() * 6.28 };
        }),
      );
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const s = (t / 1000) * 0.18 * dir;
      const k = (Math.PI * 2) / wavelength;
      for (let c = 0; c < grid.length; c++) {
        const x = offset + c * GAP;
        // Two slow swells laid over each other, so the curve never looks like a plain sine
        const mid = h / 2 + amplitude * Math.sin(k * x - s + p1) + amplitude * 0.35 * Math.sin(k * 2.3 * x + s * 0.7 + p2);
        const half = thickness * (0.7 + 0.3 * Math.sin(k * 0.6 * x - s * 0.4 + p3));
        // Fades out at the very edges of the screen instead of stopping hard
        const edge = Math.min(1, x / (w * 0.08), (w - x) / (w * 0.08));
        if (edge <= 0) continue;
        const r0 = Math.max(0, Math.floor((mid - half) / GAP));
        const r1 = Math.min(grid[c].length - 1, Math.ceil((mid + half) / GAP));
        for (let r = r0; r <= r1; r++) {
          const d = Math.abs(r * GAP - mid) / half;
          if (d >= 1) continue;
          const dot = grid[c][r];
          const glow = still || !dot.block ? 0 : 0.12 * Math.sin(t / 900 + dot.phase);
          const alpha = (dot.base + glow) * (1 - d * d) * edge;
          if (alpha < 0.008) continue;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = dot.color;
          ctx.beginPath();
          if (dot.block) ctx.roundRect(x - 3.5, r * GAP - 3.5, 7, 7, 2);
          else ctx.arc(x, r * GAP, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    layout();
    draw(0);
    let frame = 0;
    let visible = false;
    let last = 0;
    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      if (!visible || t - last < 33) return;
      last = t;
      draw(t);
    };
    if (!still) frame = requestAnimationFrame(tick);
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);
    const ro = new ResizeObserver(() => {
      layout();
      draw(performance.now());
    });
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      io.disconnect();
      ro.disconnect();
    };
  }, [seed, amplitude, thickness, dir]);

  return <canvas ref={ref} aria-hidden className={className} />;
}
