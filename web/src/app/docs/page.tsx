import type { Metadata } from "next";
import { Guide } from "@/components/docs/Guide";

export const metadata: Metadata = { title: "Using Pluribus | Docs" };

export default function UsersGuide() {
  return <Guide slug="users" />;
}
