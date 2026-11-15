import type { Metadata } from "next";
import { StatementsDashboard } from "@/components/statements/StatementsDashboard";

export const metadata: Metadata = { title: "Statements | Pluribus" };

export default function StatementsPage() {
  return <StatementsDashboard />;
}
