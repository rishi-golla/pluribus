import type { Metadata } from "next";
import { CompoundPanel } from "@/components/compound/CompoundPanel";

export const metadata: Metadata = { title: "Compound | Pluribus" };

export default function CompoundPage() {
  return (
    <main className="mx-auto max-w-[1280px] px-10 pb-16 pt-9">
      <div className="mb-3">
        <h1 className="text-[32px] font-medium leading-[1.1] tracking-[-0.035em]">Compound</h1>
        <p className="mt-2 text-[14.5px] text-t2">Compound LP fees for other borrowers and keep the bounty</p>
      </div>
      <CompoundPanel />
    </main>
  );
}
