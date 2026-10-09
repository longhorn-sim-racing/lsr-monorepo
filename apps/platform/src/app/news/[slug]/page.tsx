import { getAllPosts, getPostContent } from "@/lib/news"
import Link from "next/link"
import Image from "next/image"
import { notFound } from "next/navigation"
import { ArrowLeft, Rss } from "lucide-react"
import { formatPostDate, PostCard } from "../post-card"

import { Metadata } from "next"
import { DatabaseUnavailable } from "@/components/database-unavailable"
import { isViewerOfficer } from "@/server/auth/guards"

// Per request, not ISR: an officer's draft preview must never be cached for everyone else.
export const dynamic = "force-dynamic";


export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>
}): Promise<Metadata> {
  const { slug } = await params;

  let postData;
  try {
    postData = await getPostContent(slug);
  } catch {
    postData = null;
  }

  if (!postData || (!postData.frontmatter.published && !(await isViewerOfficer()))) {
    return {
      title: "News",
      alternates: { canonical: `/news/${slug}` },
    };
  }

  const { frontmatter } = postData;
  const description =
    frontmatter.excerpt ||
    `${frontmatter.title} — read the latest from Longhorn Sim Racing.`;

  return {
    title: frontmatter.title,
    description,
    alternates: { canonical: `/news/${slug}` },
    openGraph: {
      title: frontmatter.title,
      description,
      type: "article",
      url: `/news/${slug}`,
      publishedTime: frontmatter.date,
      authors: frontmatter.author ? [frontmatter.author] : undefined,
      tags: frontmatter.tags,
      ...(frontmatter.coverImageUrl ? { images: [{ url: frontmatter.coverImageUrl }] } : {}),
    },
    twitter: {
      title: frontmatter.title,
      description,
    },
  };
}

type RouteParams = { slug: string }

/** JSON for a <script> tag: escape "<" so post text can't close the tag early. */
function jsonLd(data: unknown) {
  return JSON.stringify(data).replace(/</g, "\\u003c")
}

export default async function NewsPostPage({
                                             params,
                                           }: {
  params: Promise<RouteParams> // 👈 Next 15: params can be async
}) {
  const { slug } = await params // 👈 await before using

  let postData;
  let allPosts: Awaited<ReturnType<typeof getAllPosts>> = [];
  try {
    [postData, allPosts] = await Promise.all([
      getPostContent(slug),
      getAllPosts(),
    ]);
  } catch (error) {
    console.error('[NewsPost] Failed to load post:', error);
    return (
      <div className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-4xl px-6 md:px-8 py-14 md:py-20">
          <DatabaseUnavailable title="Article Unavailable" />
        </div>
      </div>
    );
  }

  if (!postData) notFound()
  const isDraft = !postData.frontmatter.published
  if (isDraft && !(await isViewerOfficer())) notFound()

  const { content, frontmatter } = postData
  const relatedPosts = allPosts.filter(p => p.slug !== slug).slice(0, 3)

  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: frontmatter.title,
    description: frontmatter.excerpt || undefined,
    ...(frontmatter.coverImageUrl ? { image: frontmatter.coverImageUrl } : {}),
    datePublished: frontmatter.date,
    dateModified: frontmatter.date,
    author: {
      "@type": frontmatter.author && frontmatter.author !== "LSR Team" ? "Person" : "Organization",
      name: frontmatter.author || "Longhorn Sim Racing",
    },
    publisher: {
      "@type": "SportsOrganization",
      name: "Longhorn Sim Racing",
      logo: {
        "@type": "ImageObject",
        url: "https://www.longhornsimracing.org/brand/logos/black_logo_white_square.png",
      },
    },
    keywords: frontmatter.tags,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `https://www.longhornsimracing.org/news/${slug}`,
    },
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://www.longhornsimracing.org/" },
      { "@type": "ListItem", position: 2, name: "News", item: "https://www.longhornsimracing.org/news" },
      { "@type": "ListItem", position: 3, name: frontmatter.title, item: `https://www.longhornsimracing.org/news/${slug}` },
    ],
  };

  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(articleJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }}
      />
      <div className="mx-auto max-w-5xl px-6 md:px-8 py-14 md:py-20">
        <div className="mb-8">
          <Link href="/news" className="group inline-flex items-center gap-2 text-[10px] font-sans font-bold uppercase tracking-[0.25em] text-white/50 hover:text-lsr-orange transition-colors">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-1" />
            All news
          </Link>
        </div>

        {isDraft && (
          <div className="mb-8 border border-amber-500/30 bg-amber-500/10 px-4 py-3 font-sans text-xs text-amber-200">
            Draft: only officers can see this post. Edit it in{" "}
            <Link href={`/admin/news/${postData.id}`} className="underline hover:text-white">Admin → News</Link>.
          </div>
        )}

        <header className="mb-10 md:mb-12">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] font-sans font-bold uppercase tracking-[0.2em] text-lsr-orange mb-6">
            <time dateTime={frontmatter.date}>{formatPostDate(frontmatter.date)}</time>
            <span className="h-3 w-px bg-white/20" />
            <span className="text-white/60">By {frontmatter.author || "LSR Team"}</span>
          </div>

          <h1 className="font-display font-black italic text-4xl md:text-6xl lg:text-7xl text-white uppercase tracking-normal leading-[0.9]">
            {frontmatter.title}
          </h1>

          {frontmatter.excerpt && (
            <p className="mt-6 max-w-3xl font-sans text-lg md:text-xl text-white/70 leading-relaxed">{frontmatter.excerpt}</p>
          )}

          {frontmatter.tags && frontmatter.tags.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-2">
              {frontmatter.tags.map(tag => (
                <Link
                  key={tag}
                  href={`/news?tag=${encodeURIComponent(tag)}`}
                  className="bg-lsr-orange/10 px-2 py-0.5 text-[9px] font-sans font-black uppercase tracking-widest text-lsr-orange hover:bg-lsr-orange hover:text-white transition-colors"
                >
                  {tag}
                </Link>
              ))}
            </div>
          )}
        </header>

        {frontmatter.coverImageUrl ? (
          <div className="relative mb-12 md:mb-16 aspect-video overflow-hidden border border-white/10">
            <Image src={frontmatter.coverImageUrl} alt="" fill sizes="(min-width: 1024px) 1024px, 100vw" preload className="object-cover" />
            <div className="absolute bottom-0 left-0 h-1 w-24 bg-lsr-orange" />
          </div>
        ) : (
          <div className="mb-12 md:mb-16 h-px bg-gradient-to-r from-lsr-orange via-white/10 to-transparent" />
        )}

        <article className="mx-auto max-w-3xl prose prose-invert prose-lg
                            prose-headings:font-display prose-headings:font-black prose-headings:italic prose-headings:uppercase prose-headings:tracking-normal
                            prose-p:font-sans prose-p:text-white/80 prose-p:leading-relaxed
                            prose-a:text-lsr-orange prose-a:no-underline hover:prose-a:underline
                            prose-strong:text-white prose-strong:font-bold
                            prose-li:font-sans prose-li:text-white/80
                            prose-blockquote:border-lsr-orange prose-blockquote:bg-white/5 prose-blockquote:py-2 prose-blockquote:px-6 prose-blockquote:not-italic
                            prose-code:text-lsr-orange prose-code:bg-white/5 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-none prose-code:font-mono prose-code:before:content-none prose-code:after:content-none">
          {content}
        </article>

        {relatedPosts.length > 0 && (
          <section className="mt-20 pt-10 border-t border-white/10">
            <h2 className="font-display font-black italic text-2xl md:text-3xl text-white uppercase tracking-normal mb-8">
              More <span className="text-lsr-orange">from LSR</span>
            </h2>
            <div className="grid gap-4 md:gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {relatedPosts.map(p => (
                <PostCard key={p.slug} post={p} />
              ))}
            </div>
          </section>
        )}

        <div className="mt-20 pt-10 border-t border-white/10 flex flex-wrap items-center justify-between gap-4">
          <Link href="/news" className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/60 hover:text-lsr-orange transition-colors">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-1" />
            All news
          </Link>
          <Link href="/news/subscribe" className="inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white transition-colors">
            <Rss className="h-3.5 w-3.5" />
            Subscribe
          </Link>
        </div>
      </div>
    </div>
  )
}
