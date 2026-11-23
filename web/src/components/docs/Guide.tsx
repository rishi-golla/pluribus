import Link from "next/link";
import Markdown from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { GUIDES, guideHref, readGuide, type GuideSlug } from "@/lib/docs";
import type { BranchedMenuItem } from "./BranchedMenu";
import { CopyMarkdown } from "./CopyMarkdown";
import { SectionsMenu } from "./SectionsMenu";
import { ChevronDown } from "lucide-react";

/** One guide from the docs folder, with both guides and this one's sections in a sidebar */
export function Guide({ slug }: { slug: GuideSlug }) {
  const guide = readGuide(slug);
  const items: BranchedMenuItem[] = [];
  for (const h of guide.headings) {
    const entry = { value: h.id, label: h.text };
    const parent = items[items.length - 1];
    if (h.depth === 2 || (h.depth === 3 && !parent)) items.push(entry);
    else if (h.depth === 3) (parent.children ??= []).push(entry);
  }
  return (
    <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-8 px-4 pb-24 pt-8 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-14 lg:px-10 lg:pb-32 lg:pt-12">
      {/* beside the guide from laptop width up; above it on a phone, with the sections folded away until asked for */}
      <aside className="text-[13.5px] lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)] lg:self-start lg:overflow-y-auto lg:pr-2">
        <nav aria-label="Guides" className="flex gap-1 lg:grid lg:gap-0.5">
          {GUIDES.map((g) => (
            <Link
              key={g.slug}
              href={g.href}
              aria-current={g.slug === slug ? "page" : undefined}
              className={`rounded-lg px-3 py-2 font-medium transition-colors ${g.slug === slug ? "bg-s3 text-t1" : "text-t2 hover:text-t1"}`}
            >
              {g.label}
            </Link>
          ))}
        </nav>
        <details className="group mt-4 rounded-[10px] border border-line bg-s1 lg:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-3 text-[13px] font-medium text-t2 [&::-webkit-details-marker]:hidden">
            On this page
            <ChevronDown size={15} strokeWidth={1.75} className="text-t3 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-line px-3.5 pb-3 pt-2">
            <SectionsMenu items={items} />
          </div>
        </details>
        <div className="hidden lg:block">
          <div className="mt-7 px-3 text-[12px] font-medium text-t3">On this page</div>
          <div className="mt-2 pl-3">
            <SectionsMenu items={items} />
          </div>
        </div>
      </aside>
      <article className="docs min-w-0 max-w-[760px]">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug]}
          components={{
            // the page title shares its row with the copy button, which sits at the top right of the guide
            h1: ({ id, children }) => (
              <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <h1 id={id}>{children}</h1>
                <CopyMarkdown markdown={guide.markdown} />
              </div>
            ),
            a: ({ href = "", children }) => {
              const to = guideHref(href);
              return to.startsWith("/") ? <Link href={to}>{children}</Link> : <a href={to} {...(/^https?:/.test(to) ? { target: "_blank", rel: "noreferrer" } : {})}>{children}</a>;
            },
            table: ({ children }) => (
              <div className="docs-table">
                <table>{children}</table>
              </div>
            ),
          }}
        >
          {guide.markdown}
        </Markdown>
      </article>
    </div>
  );
}
