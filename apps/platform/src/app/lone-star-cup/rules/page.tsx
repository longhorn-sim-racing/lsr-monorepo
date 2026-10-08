import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { isViewerOfficer } from "@/server/auth/guards";
import { getPageBySlug, LSC_RULES_SLUG, renderPageMarkdown } from "@/lib/pages";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lone Star Cup Rules",
  description: "Race format, car setup, practice, qualifying and race rules for the Lone Star Cup.",
  alternates: { canonical: "/lone-star-cup/rules" },
};


export default async function LoneStarCupRulesPage() {
  const page = await getPageBySlug(LSC_RULES_SLUG);
  // Drafts (not public yet) are only visible to officers, so the comp team can review them here.
  const isDraft = !!page && page.visibility !== "public";
  if (!page || (isDraft && !(await isViewerOfficer()))) notFound();

  const content = await renderPageMarkdown(page.bodyMd);

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <div className="mx-auto max-w-3xl px-6 md:px-8 py-14 md:py-20">
        <Link href="/lone-star-cup" className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 transition-colors hover:text-lsr-orange">
          ← Lone Star Cup
        </Link>

        {isDraft && (
          <div className="mt-6 border border-amber-500/30 bg-amber-500/10 px-4 py-3 font-sans text-xs text-amber-200">
            Draft: only officers can see this page. Publish it in{" "}
            <Link href={`/admin/pages/${page.id}`} className="underline hover:text-white">Admin → Pages</Link>.
          </div>
        )}

        <article
          className="mt-8 prose prose-invert max-w-none
                     prose-headings:font-display prose-headings:font-black prose-headings:italic prose-headings:uppercase prose-headings:tracking-normal
                     prose-h1:text-4xl md:prose-h1:text-5xl prose-h2:mt-12 prose-h2:border-b prose-h2:border-white/10 prose-h2:pb-3
                     prose-p:font-sans prose-p:text-white/80 prose-p:leading-relaxed
                     prose-li:font-sans prose-li:text-white/80 prose-strong:text-white
                     prose-a:text-lsr-orange prose-a:no-underline hover:prose-a:underline
                     prose-blockquote:border-lsr-orange prose-blockquote:bg-white/5 prose-blockquote:py-2 prose-blockquote:px-6 prose-blockquote:not-italic"
        >
          {content}
        </article>

        <p className="mt-12 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">
          Last updated {page.updatedAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" })}
        </p>
      </div>
    </main>
  );
}
