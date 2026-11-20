"use client";

import type { ReactNode } from "react";
import CursorGrid from "@/components/reactbits/CursorGrid";

/** The page's last screen: the hero's squares again, dark until the cursor passes and lights them */
export function Closing({ children }: { children: ReactNode }) {
  return (
    <div className="h-[420px] overflow-hidden rounded-2xl border border-line sm:h-[480px]">
      <CursorGrid cellSize={28} color="#c6f432" gridColor="#ffffff" gridStyle="lines" highlight="cell" cellGap={1} radius={170} fillOpacity={0.9} gridOpacity={0.06} spotlight={0} ambient={0.25} edgeFade={0} holdTime={500} fadeDuration={1400}>
        <div className="pointer-events-none flex h-full flex-col justify-end gap-8 p-7 sm:p-12 md:flex-row md:items-end md:justify-between [&_a]:pointer-events-auto">{children}</div>
      </CursorGrid>
    </div>
  );
}
