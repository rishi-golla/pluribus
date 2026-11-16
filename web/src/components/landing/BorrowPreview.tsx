"use client";

import { AppNav } from "@/components/app/AppNav";
import { AppProviders } from "@/components/app/providers";
import { BorrowDashboard } from "@/components/borrow/BorrowDashboard";

/** The real Borrow dashboard at its native 1440px width, with its own demo state, for the landing page frame. */
export function BorrowPreview() {
  return (
    <AppProviders preview>
      <div className="relative bg-bg">
        <div className="app-ambient pointer-events-none absolute inset-x-0 top-0 h-[520px]" />
        <div className="relative">
          <AppNav active="/borrow" />
          <BorrowDashboard full={false} />
        </div>
      </div>
    </AppProviders>
  );
}
