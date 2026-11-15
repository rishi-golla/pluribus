import type { Metadata } from "next";
import { BorrowDashboard } from "@/components/borrow/BorrowDashboard";

export const metadata: Metadata = { title: "Borrow | Pluribus" };

export default function BorrowPage() {
  return <BorrowDashboard />;
}
