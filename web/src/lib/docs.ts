import fs from "node:fs";
import path from "node:path";
import GithubSlugger from "github-slugger";

/** The guides in the repository's docs folder, each served as one page */
export const GUIDES = [
  { slug: "users", file: "users.md", href: "/docs", label: "Borrowers and lenders" },
  { slug: "liquidators", file: "liquidators.md", href: "/docs/liquidators", label: "Liquidators" },
] as const;
export type GuideSlug = (typeof GUIDES)[number]["slug"];

export type Heading = { depth: number; text: string; id: string };

// next dev and next build both run from web/, and the guides live one level up so GitHub shows them too
const DOCS = path.join(process.cwd(), "..", "docs");

/** A guide's markdown and its headings, with the ids rehype-slug gives them */
export function readGuide(slug: GuideSlug) {
  const guide = GUIDES.find((g) => g.slug === slug)!;
  const markdown = fs.readFileSync(path.join(DOCS, guide.file), "utf8");
  // One slugger over every heading in order, the way rehype-slug numbers repeated titles
  const slugger = new GithubSlugger();
  const headings: Heading[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const m = !fenced && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].replace(/`/g, "");
    headings.push({ depth: m[1].length, text, id: slugger.slug(text) });
  }
  return { ...guide, markdown, headings };
}

/** Points a link between the guides at their pages, and leaves every other link alone */
export function guideHref(href: string) {
  const [file, hash] = href.split("#");
  const target = GUIDES.find((g) => g.file === file.replace(/^\.\//, ""));
  return target ? `${target.href}${hash ? `#${hash}` : ""}` : href;
}
