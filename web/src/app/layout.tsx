import type { Metadata } from "next";
import { Geist_Mono, Instrument_Sans } from "next/font/google";
import { MotionProvider } from "@/components/motion";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pluribus | Borrow against everything you hold",
  description:
    "Borrow USDC against your SOL, staked SOL, liquidity positions, tokenized stocks and memecoins in one loan. No end date, and your LP fees pay it down.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${instrumentSans.variable} ${geistMono.variable} antialiased`}>
      <body className="overflow-x-hidden">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
