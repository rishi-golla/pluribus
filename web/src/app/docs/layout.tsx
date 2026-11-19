import Link from "next/link";
import { Brandmark, Button } from "@/components/ui";

const LINKS = [
  { href: "/borrow", label: "Borrow" },
  { href: "/earn", label: "Earn" },
  { href: "/docs", label: "Docs" },
];

export default function DocsLayout({ children }: LayoutProps<"/docs">) {
  return (
    <div className="min-h-screen bg-bg">
      <div className="app-ambient pointer-events-none absolute inset-x-0 top-0 h-[520px]" />
      <div className="relative">
        <header className="flex h-16 items-center gap-10 border-b border-line px-7">
          <Brandmark />
          <nav className="flex gap-0.5">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={` px-3.5 py-2 text-sm font-medium transition-colors ${l.href === "/docs" ? "bg-s3 text-t1" : "text-t2 hover:text-t1"}`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto">
            <Button variant="white" href="/overview">
              Launch app
            </Button>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
