import Link from "next/link";
import Markdown from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { GUIDES, guideHref, readGuide, type GuideSlug } from "@/lib/docs";

/** One guide from the docs folder, with both guides and this one's sections in a sidebar */
export function Guide({ slug }: { slug: GuideSlug }) {
  const guide = readGuide(slug);
  const sections = guide.headings.filter((h) => h.depth === 2 || h.depth === 3);
  return (
    <div className="mx-auto grid max-w-[1180px] grid-cols-[220px_minmax(0,1fr)] gap-14 px-10 pb-32 pt-12">
      <aside className="sticky top-8 max-h-[calc(100vh-4rem)] self-start overflow-y-auto pr-2 text-[13.5px]">
        <nav aria-label="Guides" className="grid gap-0.5">
          {GUIDES.map((g) => (
            <Link
              key={g.slug}
              href={g.href}
              aria-current={g.slug === slug ? "page" : undefined}
              className={`rounded-[9px] px-3 py-2 font-medium transition-colors ${g.slug === slug ? "bg-s3 text-t1" : "text-t2 hover:text-t1"}`}
            >
              {g.label}
            </Link>
          ))}
        </nav>
        <div className="mt-7 px-3 text-[12px] font-medium text-t3">On this page</div>
        <nav aria-label="Sections" className="mt-2 grid gap-px">
          {sections.map((h) => (
            <a key={h.id} href={`#${h.id}`} className={`rounded-md py-1 pr-2 text-t2 transition-colors hover:text-t1 ${h.depth === 3 ? "pl-6 text-[13px] text-t3" : "pl-3"}`}>
              {h.text}
            </a>
          ))}
        </nav>
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
