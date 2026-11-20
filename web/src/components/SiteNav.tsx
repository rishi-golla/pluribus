"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
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
  return (
    <div className="sticky top-0 z-40">
      <header className="flex h-16 items-center gap-10 border-b border-line bg-[rgb(12_12_12/0.7)] px-4 backdrop-blur-md sm:px-7">
        <Brandmark />
        <nav className="hidden gap-0.5 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                current === l.href || current.startsWith(`${l.href}/`) ? "bg-s3 text-t1" : "text-t2 hover:text-t1"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </header>
      {below}
    </div>
  );
}
