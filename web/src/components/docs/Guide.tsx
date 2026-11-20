import Link from "next/link";
import Markdown from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { GUIDES, guideHref, readGuide, type GuideSlug } from "@/lib/docs";
import type { BranchedMenuItem } from "./BranchedMenu";
import { SectionsMenu } from "./SectionsMenu";

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
    <div className="mx-auto grid max-w-[1180px] grid-cols-[260px_minmax(0,1fr)] gap-14 px-10 pb-32 pt-12">
      <aside className="sticky top-24 max-h-[calc(100vh-8rem)] self-start overflow-y-auto pr-2 text-[13.5px]">
        <nav aria-label="Guides" className="grid gap-0.5">
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
        <div className="mt-7 px-3 text-[12px] font-medium text-t3">On this page</div>
        <div className="mt-2 pl-3">
          <SectionsMenu items={items} />
        </div>
      </aside>
      <article className="docs min-w-0 max-w-[760px]">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug]}
          components={{
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
