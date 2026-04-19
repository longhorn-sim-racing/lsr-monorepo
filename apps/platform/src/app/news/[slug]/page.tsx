import { notFound } from "next/navigation"
import { getAllPosts, getPostContent } from "@/lib/news"
import Link from "next/link"

import { Separator } from "@/components/ui/separator"
import { Metadata } from "next"
import { DatabaseUnavailable } from "@/components/database-unavailable"

export const revalidate = 60;

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

  if (!postData) {
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
    },
    twitter: {
      title: frontmatter.title,
      description,
    },
  };
}

export async function generateStaticParams() {
  try {
    const posts = await getAllPosts()
    return posts.map(({ slug }) => ({ slug }))
  } catch {
    return []
  }
}

type RouteParams = { slug: string }

export default async function NewsPostPage({
                                             params,
                                           }: {
  params: Promise<RouteParams> // 👈 Next 15: params can be async
}) {
  const { slug } = await params // 👈 await before using

  let postData;
  try {
    postData = await getPostContent(slug);
  } catch (error) {
    console.error('[NewsPost] Failed to load post:', error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-4xl px-6 md:px-8 py-14 md:py-20">
          <DatabaseUnavailable title="Article Unavailable" />
        </div>
      </main>
    );
  }

  const { content, frontmatter } = postData

  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: frontmatter.title,
    description: frontmatter.excerpt || undefined,
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
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <div className="mx-auto max-w-4xl px-6 md:px-8 py-14 md:py-20">
        <div className="mb-8">
          <Link href="/news" className="group inline-flex items-center gap-3 text-[10px] font-sans font-bold uppercase tracking-[0.25em] text-white/50 hover:text-lsr-orange transition-colors">
            <div className="h-px w-8 bg-lsr-orange/30 group-hover:bg-lsr-orange group-hover:w-12 transition-all" />
            Back to News
          </Link>
        </div>

        <header className="mb-12 border-b border-white/10 pb-12">
          <div className="flex items-center gap-4 text-[10px] font-sans font-bold uppercase tracking-[0.2em] text-lsr-orange mb-6">
            <time>{new Date(frontmatter.date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</time>
            <span className="text-white/20">|</span>
            <span>{frontmatter.author || "Official Team Report"}</span>
          </div>
          
          <h1 className="font-display font-black italic text-4xl md:text-6xl lg:text-7xl text-white uppercase tracking-normal leading-[0.9] mb-8">
            {frontmatter.title}
          </h1>
          
          {frontmatter.tags && frontmatter.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {frontmatter.tags.map(tag => (
                <span key={tag} className="border border-white/10 bg-white/5 px-3 py-1 text-[9px] font-sans font-bold uppercase tracking-widest text-white/60">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </header>

        <article className="prose prose-invert prose-lg max-w-none 
                            prose-headings:font-display prose-headings:font-black prose-headings:italic prose-headings:uppercase prose-headings:tracking-normal
                            prose-p:font-sans prose-p:text-white/80 prose-p:leading-relaxed
                            prose-a:text-lsr-orange prose-a:no-underline hover:prose-a:underline
                            prose-strong:text-white prose-strong:font-bold
                            prose-li:font-sans prose-li:text-white/80
                            prose-blockquote:border-lsr-orange prose-blockquote:bg-white/5 prose-blockquote:py-2 prose-blockquote:px-6 prose-blockquote:not-italic
                            prose-code:text-lsr-orange prose-code:bg-white/5 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-none prose-code:font-mono prose-code:before:content-none prose-code:after:content-none">
          {content}
        </article>
        
        <div className="mt-20 pt-10 border-t border-white/10">
          <div className="flex justify-between items-center">
            <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/30">End of Transmission</span>
            <div className="h-1 w-12 bg-lsr-orange" />
          </div>
        </div>
      </div>
    </main>
  )
}
