import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, ChevronDown, Mail } from "lucide-react";
import { isViewerOfficer } from "@/server/auth/guards";
import { getPageBySlug, LSC_RULES_SLUG, renderPageMarkdown } from "@/lib/pages";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lone Star Cup Rules",
  description: "Race format, car setup, practice, qualifying and race rules for the Lone Star Cup.",
  alternates: { canonical: "/lone-star-cup/rules" },
};

/**
 * The document's "## " headings with the ids rehype-slug gives them (GitHub-style: lowercase,
 * punctuation dropped, spaces to hyphens, -1/-2 on repeats), for the contents list.
 */
function sections(bodyMd: string) {
  const seen = new Map<string, number>();
  const all = bodyMd
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => {
      const level = line.match(/^#+/)![0].length;
      const text = line
        .replace(/^#+\s+/, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]/g, "")
        .trim();
      const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { level, text, id: n === 0 ? base : `${base}-${n}` };
    });
  return all.filter((h) => h.level === 2);
}

export default async function LoneStarCupRulesPage() {
  const page = await getPageBySlug(LSC_RULES_SLUG);
  // Drafts (not public yet) are only visible to officers, so the comp team can review them here.
  const isDraft = !!page && page.visibility !== "public";
  if (!page || (isDraft && !(await isViewerOfficer()))) notFound();

  const content = await renderPageMarkdown(page.bodyMd);
  const toc = sections(page.bodyMd);
  const updated = page.updatedAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });

  const tocList = (
    <ol className="space-y-1 font-sans text-sm">
      {toc.map((section, i) => (
        <li key={section.id}>
          <a href={`#${section.id}`} className="flex gap-3 py-1.5 text-white/65 transition-colors hover:text-lsr-orange">
            <span className="w-5 shrink-0 font-display font-black italic text-white/30">{String(i + 1).padStart(2, "0")}</span>
            {section.text}
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      <div className="relative overflow-hidden border-b border-white/10 bg-black/25">
        <div className="absolute inset-0 opacity-[0.04] [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />
        <div className="relative mx-auto max-w-6xl px-6 md:px-8 pt-10 pb-12 md:pt-14 md:pb-14">
          <Link href="/lone-star-cup" className="group inline-flex items-center gap-2 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/60 transition-colors hover:text-lsr-orange">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-1" />
            Lone Star Cup
          </Link>
          <div className="mt-8 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <Image src="/images/lone-star-cup-logo.png" alt="" width={509} height={218} className="h-auto w-32 md:w-40" />
              <h1 className="mt-5 font-display font-black italic text-5xl md:text-7xl uppercase leading-[0.9]">
                The <span className="text-lsr-orange">rules</span>
              </h1>
              <p className="mt-4 font-sans text-sm text-white/55">Last updated {updated}</p>
            </div>
            <p className="max-w-sm font-sans text-sm leading-relaxed text-white/65">
              Race format, setup, sessions and penalties. Entering the Lone Star Cup means you agree to these.
            </p>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-10 md:py-14">
        {isDraft && (
          <div className="mb-8 border border-amber-500/30 bg-amber-500/10 px-4 py-3 font-sans text-xs text-amber-200">
            Draft: only officers can see this page. Publish it in{" "}
            <Link href={`/admin/pages/${page.id}`} className="underline hover:text-white">Admin → Pages</Link>.
          </div>
        )}

        <div className="grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-14">
          {toc.length > 0 && (
            <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
              {/* Phones: a collapsible list above the rules */}
              <details className="group border border-white/10 bg-white/[0.02] lg:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 font-sans font-bold text-[11px] uppercase tracking-[0.2em] text-white [&::-webkit-details-marker]:hidden">
                  On this page
                  <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <div className="border-t border-white/10 px-4 py-3">{tocList}</div>
              </details>
              <div className="hidden lg:block">
                <p className="mb-3 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">On this page</p>
                {tocList}
              </div>
            </nav>
          )}

          <div className="min-w-0 max-w-3xl">
            <article
              className="prose prose-invert max-w-none
                         [&>h1:first-child]:hidden
                         prose-headings:font-display prose-headings:font-black prose-headings:italic prose-headings:uppercase prose-headings:tracking-normal prose-headings:scroll-mt-24
                         prose-h2:mt-14 prose-h2:border-b prose-h2:border-white/10 prose-h2:pb-3 prose-h2:text-3xl
                         prose-h3:text-lsr-orange
                         prose-p:font-sans prose-p:text-white/80 prose-p:leading-relaxed
                         prose-li:font-sans prose-li:text-white/80 prose-li:marker:text-lsr-orange prose-strong:text-white
                         prose-a:text-lsr-orange prose-a:no-underline hover:prose-a:underline
                         prose-table:text-sm prose-th:text-white prose-td:text-white/80
                         prose-blockquote:border-lsr-orange prose-blockquote:bg-white/5 prose-blockquote:py-2 prose-blockquote:px-6 prose-blockquote:not-italic"
            >
              {content}
            </article>

            <div className="relative mt-14 flex flex-col gap-4 border border-white/10 bg-white/[0.02] p-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
              <p className="font-sans text-sm text-white/70">Something unclear, or think a rule needs a look? Ask the series directors.</p>
              <a
                href="mailto:info@longhornsimracing.org"
                className="inline-flex shrink-0 items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white"
              >
                <Mail className="h-4 w-4" aria-hidden />
                Email us
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
