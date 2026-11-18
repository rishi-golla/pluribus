"use client";

import { motion } from "motion/react";
import { EASE } from "@/components/motion";

const W = 335;
const DAYS = 30;
const barW = (W - (DAYS - 1) * 3) / DAYS;
// A sliver of every bar shows even on a day with nothing repaid, so the 30 days still read as a chart
const MIN_H = 2.2;

/** Daily autopay bars that grow in left to right when scrolled into view, flat placeholders while `days` is null */
export function FeeBars({ days }: { days: number[] | null }) {
  const top = Math.max(0, ...(days ?? []));
  return (
    <motion.svg
      viewBox={`0 0 ${W} 96`}
      width="100%"
      height="96"
      className="inline align-baseline"
      aria-label={days ? "USDC repaid by autopay per day over the last 30 days" : "No autopay history to show"}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, amount: 0.6 }}
    >
      {Array.from({ length: DAYS }, (_, i) => {
        const v = days?.[i] ?? 0;
        const h = top > 0 ? Math.max(MIN_H, (v / top) * 90) : MIN_H;
        return (
          <motion.rect
            key={i}
            x={i * (barW + 3)}
            y={96 - h}
            width={barW}
            height={h}
            rx={2}
            fill="#9e8cff"
            fillOpacity={days ? 0.25 + (i / (DAYS - 1)) * 0.6 : 0.15}
            style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
            variants={{ hidden: { scaleY: 0 }, shown: { scaleY: 1 } }}
            transition={{ duration: 0.6, delay: i * 0.025, ease: EASE }}
          />
        );
      })}
    </motion.svg>
  );
}
