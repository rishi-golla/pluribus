"use client";

import { useEffect, useRef } from "react";
import { seeded } from "./assets";

const GAP = 24;
// Share of the field each asset class takes: SOL and LSTs, LP positions, stocks, USDC
const WEIGHTS = [0.34, 0.28, 0.22, 0.16];
const VARS = ["--color-brand", "--color-blue", "--color-green", "--color-t2"];

type Props = {
  className?: string;
  /** Scales every dot's brightness, 1 for the full field */
  strength?: number;
  /** Share of grid points drawn as larger glowing blocks */
  blocks?: number;
  /** An ellipse, in pixels from the field's top center, where dots fade toward nothing so text on top stays crisp */
  clear?: { y: number; rx: number; ry: number };
};

/** A grid of mixed colored dots, with a few larger blocks that slowly brighten and fade */
export function DotField({ className, strength = 1, blocks = 0.05, clear }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Plain numbers, so a new object with the same zone each render does not redraw the field
  const [clearY, clearRx, clearRy] = clear ? [clear.y, clear.rx, clear.ry] : [0, 0, 0];

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const css = getComputedStyle(document.documentElement);
    const colors = VARS.map((v) => css.getPropertyValue(v).trim() || "#9e8cff");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    type Dot = { x: number; y: number; color: string; base: number; block: boolean; phase: number; speed: number };
    let dots: Dot[] = [];
    let w = 0;
    let h = 0;

    const layout = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Seeded from the grid position, so resizing keeps each dot's color
      const cols = Math.ceil(w / GAP) + 1;
      const rows = Math.ceil(h / GAP) + 1;
      const offset = (w % GAP) / 2;
      dots = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const rand = seeded(r * 7919 + (c - Math.floor(cols / 2)) * 104729);
          const pick = rand();
          let k = 0;
          for (let acc = WEIGHTS[0]; pick > acc && k < WEIGHTS.length - 1; acc += WEIGHTS[++k]);
          const x = offset + c * GAP;
          const y = r * GAP;
          // 0 at the middle of the clear zone, rising smoothly to 1 at its edge and beyond
          const r2 = clearRx ? ((x - w / 2) / clearRx) ** 2 + ((y - clearY) / clearRy) ** 2 : 1;
          const open = Math.min(1, r2) ** 1.5;
          const block = open > 0.9 && rand() < blocks;
          const base = (block ? 0.55 : 0.16 + rand() * 0.22) * strength * (0.08 + 0.92 * open);
          dots.push({ x, y, color: colors[k], base, block, phase: rand() * Math.PI * 2, speed: 0.4 + rand() * 0.8 });
        }
      }
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const d of dots) {
        const glow = still || !d.block ? 0 : 0.35 * Math.sin(t / 1000 * d.speed + d.phase);
        const alpha = Math.min(1, d.base + glow * strength);
        if (alpha < 0.01) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = d.color;
        if (d.block) {
          ctx.beginPath();
          ctx.roundRect(d.x - 4, d.y - 4, 8, 8, 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(d.x, d.y, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    layout();
    draw(0);
    let frame = 0;
    let visible = true;
    let last = 0;
    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      // About 30 frames a second is plenty for a slow shimmer
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
  }, [strength, blocks, clearY, clearRx, clearRy]);

  return <canvas ref={ref} aria-hidden className={className} />;
}
