import type { ReactNode } from "react";
import { AppNav } from "@/components/app/AppNav";
import { AppProviders, LiveGate } from "@/components/app/providers";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppProviders>
      <div className="relative min-h-screen bg-bg">
        <div className="app-ambient pointer-events-none absolute inset-x-0 top-0 h-[520px]" />
        <div className="relative">
          <AppNav />
          <LiveGate>{children}</LiveGate>
        </div>
      </div>
    </AppProviders>
  );
}
