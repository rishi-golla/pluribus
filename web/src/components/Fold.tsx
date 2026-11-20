"use client";

import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState, type ReactNode } from "react";
import { EASE } from "@/components/motion";

type FoldProps = {
  title: string;
  /** What the closed row says on its right, a figure or a few words */
  summary?: ReactNode;
  /** Pass both to open and close it from outside */
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
};

/** A secondary panel kept as one row until it is asked for, so a page leads with its main job */
export function Fold({ title, summary, open: controlled, onToggle, children }: FoldProps) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle ?? (() => setOwn(!own))}
        className={`flex w-full cursor-pointer items-center text-left transition-colors ${
          open ? "mb-2 justify-end gap-1.5 px-1 text-[12.5px] text-t3 hover:text-t1" : "panel gap-4 px-[22px] py-4 hover:border-line-2"
        }`}
      >
        {open ? (
          <>
            Hide {title.toLowerCase()}
            <ChevronUp size={14} strokeWidth={1.75} />
          </>
        ) : (
          <>
            <span className="text-[15px] font-medium tracking-[-0.01em]">{title}</span>
            <span className="ml-auto truncate text-[13px] text-t2">{summary}</span>
            <ChevronDown size={16} strokeWidth={1.75} className="shrink-0 text-t3" />
          </>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          // the padding leaves room for a highlight ring inside the clip
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.35, ease: EASE }} className="-m-2 overflow-hidden p-2">
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
