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

// the logo as a data url: the repo ignores .svg files, so an icon file would never reach a fresh clone
const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0c0c0c"/><g fill="#c6f432" transform="translate(4 4)"><rect width="15" height="15"/><rect x="16" width="8" height="8"/><rect y="16" width="15" height="8"/><rect x="16" y="9" width="8" height="15"/></g></svg>',
  );

export const metadata: Metadata = {
  title: "Pluribus | Borrow against everything you hold",
  icons: { icon: ICON },
  description:
    "Borrow USDC against your SOL, tokenized stocks and Orca LP positions in one loan. No end date.",
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
