import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { MotionProvider } from "@/components/motion";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pluribus | Borrow against everything you hold",
  description:
    "One credit line for your SOL, LSTs, LP positions and tokenized stocks. Crash-tested valuation, no maturity, repaid by your LP fees.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="overflow-x-hidden">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
