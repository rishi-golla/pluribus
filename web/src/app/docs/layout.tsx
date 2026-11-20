import { SiteNav } from "@/components/SiteNav";
import { Button } from "@/components/ui";

export default function DocsLayout({ children }: LayoutProps<"/docs">) {
  return (
    <div className="min-h-screen bg-bg">
      <div className="app-ambient pointer-events-none absolute inset-x-0 top-0 h-[520px]" />
      <div className="relative">
        <SiteNav>
          <Button variant="white" href="/overview">
            Launch app
          </Button>
        </SiteNav>
        {children}
      </div>
    </div>
  );
}
