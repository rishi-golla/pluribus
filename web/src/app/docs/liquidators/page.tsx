import type { Metadata } from "next";
import { Guide } from "@/components/docs/Guide";

export const metadata: Metadata = { title: "Liquidating on Pluribus | Docs" };

export default function LiquidatorsGuide() {
  return <Guide slug="liquidators" />;
}
