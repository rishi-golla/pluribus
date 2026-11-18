"use client";

import { motion } from "motion/react";
import { series } from "@/lib/chart";
import { EASE } from "@/components/motion";

const W = 335;
const fees = series(30, 6, 8, 5, 3).map((v) => Math.max(2.2, v));
const barW = (W - 29 * 3) / 30;

/** Daily autopay bars that grow in left to right when scrolled into view. */
export function FeeBars() {
  return (
    <motion.svg
      viewBox={`0 0 ${W} 96`}
      width="100%"
      height="96"
      className="inline align-baseline"
      aria-label="Fees repaid per day over the last 30 days"
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, amount: 0.6 }}
    >
      {fees.map((v, i) => {
        const h = (v / 14) * 90;
        return (
          <motion.rect
            key={i}
            x={i * (barW + 3)}
            y={96 - h}
            width={barW}
            height={h}
            rx={2}
            fill="#9e8cff"
            fillOpacity={0.25 + (i / 29) * 0.6}
            style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
            variants={{ hidden: { scaleY: 0 }, shown: { scaleY: 1 } }}
            transition={{ duration: 0.6, delay: i * 0.025, ease: EASE }}
          />
        );
      })}
    </motion.svg>
  );
}
