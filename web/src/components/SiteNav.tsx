"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { useId, type ReactNode } from "react";
import { Brandmark } from "@/components/ui";

const LINKS = [
  { href: "/overview", label: "Overview" },
  { href: "/borrow", label: "Borrow" },
  { href: "/earn", label: "Earn" },
  { href: "/statements", label: "Statements" },
  { href: "/docs", label: "Docs" },
];

/**
 * The one header for the landing, the docs and the app, so it never moves or changes tabs between pages.
 * `children` is the right side, `below` a strip pinned under it, and `active` pins a tab for the landing's preview frame.
 */
export function SiteNav({ active, below, children }: { active?: string; below?: ReactNode; children?: ReactNode }) {
  const pathname = usePathname();
  const current = active ?? pathname;
  const pill = useId();
  const tabs = (id: string, cls: string) =>
    LINKS.map((l) => {
      const on = current === l.href || current.startsWith(`${l.href}/`);
      return (
        <Link key={l.href} href={l.href} aria-current={on ? "page" : undefined} className={`relative whitespace-nowrap rounded-lg font-medium transition-colors ${cls} ${on ? "text-t1" : "text-t2 hover:text-t1"}`}>
          {/* the highlight is one element that slides to the page being opened */}
          {on && <motion.span layoutId={id} layoutDependency={current} className="absolute inset-0 rounded-lg bg-s3" transition={{ type: "spring", stiffness: 520, damping: 42 }} />}
          <span className="relative">{l.label}</span>
        </Link>
      );
    });
  return (
    <div className="sticky top-0 z-40">
      <header className="flex h-16 items-center gap-4 border-b border-line bg-[rgb(12_12_12/0.7)] px-4 backdrop-blur-md sm:px-7 md:gap-6 lg:gap-10">
        <Brandmark />
        <nav aria-label="Pages" className="hidden gap-0.5 md:flex">
          {tabs(pill, "px-3.5 py-2 text-sm")}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div>
      </header>
      {/* under tablet width the tabs get a row of their own, which scrolls sideways when the screen is too narrow for all of them */}
      <nav aria-label="Pages" className="no-scrollbar flex gap-0.5 overflow-x-auto border-b border-line bg-[rgb(12_12_12/0.85)] px-2.5 py-1.5 backdrop-blur-md md:hidden">
        {tabs(`${pill}-row`, "px-3 py-1.5 text-[13.5px]")}
      </nav>
      {below}
    </div>
  );
}
