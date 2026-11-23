"use client";

import { motion } from "motion/react";
import { useId } from "react";

type SegmentedProps<T extends string> = {
  items: readonly T[];
  value: T;
  onChange: (v: T) => void;
  small?: boolean;
  label: string;
};

export function Segmented<T extends string>({ items, value, onChange, small = false, label }: SegmentedProps<T>) {
  const thumb = useId();
  return (
    <div className="no-scrollbar flex max-w-full overflow-x-auto rounded-lg border border-line bg-bg p-[3px]" role="tablist" aria-label={label}>
      {items.map((it) => {
        const on = it === value;
        return (
          <button
            key={it}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(it)}
            className={`relative flex-1 cursor-pointer whitespace-nowrap rounded-md text-center font-medium transition-colors duration-200 ${
              small ? "px-[9px] py-1 text-xs" : "px-3 py-[7px] text-[13px]"
            } ${on ? "text-t1" : "text-t3 hover:text-t2"}`}
          >
            {/* one thumb shared by the tabs, so it slides to the picked one; it only moves when the pick changes, not when the page shifts under it */}
            {on && (
              <motion.span
                layoutId={thumb}
                layoutDependency={value}
                className="absolute inset-0 rounded-md bg-s3 shadow-[inset_0_0_0_1px_var(--color-line-2)]"
                transition={{ type: "spring", stiffness: 520, damping: 42 }}
              />
            )}
            <span className="relative">{it}</span>
          </button>
        );
      })}
    </div>
  );
}
