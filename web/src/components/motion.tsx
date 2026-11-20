"use client";

import { MotionConfig, motion, useInView, useMotionValueEvent, useReducedMotion, useSpring } from "motion/react";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

/** One easing curve for the whole product: fast out, long soft settle. */
export const EASE = [0.22, 1, 0.36, 1] as const;

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.7, ease: EASE }}>
      {children}
    </MotionConfig>
  );
}

type FadeUpProps = {
  children?: ReactNode;
  className?: string;
  delay?: number;
  duration?: number;
  y?: number;
  /** Animate as soon as the page loads instead of when scrolled into view. */
  onMount?: boolean;
};

export function FadeUp({ children, className, delay = 0, duration = 0.8, y = 16, onMount = false }: FadeUpProps) {
  const target = { opacity: 1, y: 0 };
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      {...(onMount ? { animate: target } : { whileInView: target, viewport: { once: true, amount: 0.3 } })}
      transition={{ duration, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

type NumProps = {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Count up from zero the first time the number scrolls into view. */
  countUp?: boolean;
  className?: string;
};

const format = (v: number, decimals: number, prefix: string, suffix: string) =>
  prefix + v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;

/** A number that springs to new values. Writes to the DOM directly so animating never re-renders React. */
export function Num({ value, decimals = 0, prefix = "", suffix = "", countUp = false, className }: NumProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const inView = useInView(ref, { once: true, amount: 0.5 });
  const mv = useSpring(countUp ? 0 : value, { stiffness: 90, damping: 22, mass: 0.9 });

  // The text shows where the spring is, which is zero on a first count up. Next.js keeps a page it navigates away from and
  // runs its effects again when it comes back, with the spring already at its value: writing zero then would leave the
  // number stuck there, since a spring set to the value it holds never moves again
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = format(reduce ? value : mv.get(), decimals, prefix, suffix);
  }, [countUp, reduce, decimals, prefix, suffix, mv, value]);

  useEffect(() => {
    if (reduce) mv.jump(value);
    else if (!countUp || inView) mv.set(value);
  }, [value, inView, countUp, reduce, mv]);

  useMotionValueEvent(mv, "change", (v) => {
    if (ref.current) ref.current.textContent = format(v, decimals, prefix, suffix);
  });

  return (
    <span ref={ref} className={className}>
      {format(value, decimals, prefix, suffix)}
    </span>
  );
}
