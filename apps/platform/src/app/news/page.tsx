import Link from "next/link"
import { getAllPosts } from "@/lib/news"
import { Separator } from "@/components/ui/separator"
import { NewsSearch } from "@/components/news-search"
import { NewsFilters } from "@/components/news-filters"
import { Metadata } from "next"
import { DatabaseUnavailable } from "@/components/database-unavailable"

export const metadata: Metadata = {
  title: "Team News",
  description: "Latest updates, race reports, and announcements from Longhorn Sim Racing.",
  alternates: {
    canonical: "/news",
  },
};

export const revalidate = 60 // revalidate list once per min

export default async function NewsIndexPage({
                                              searchParams,
                                            }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const q = typeof sp.q === "string" ? sp.q.trim() : ""
  const tagParam = sp.tag
  const selectedTags = (Array.isArray(tagParam) ? tagParam : tagParam ? [tagParam] : [])
    .map((t) => t.toString().toLowerCase())

  let allPosts;
  try {
    allPosts = await getAllPosts();
  } catch (error) {
    console.error('[News] Failed to load posts:', error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <div className="mb-10">
            <h1 className="font-display font-black italic text-5xl md:text-6xl text-white uppercase tracking-normal">
              Team <span className="text-lsr-orange">News</span>
            </h1>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-2">Latest Updates & Reports</p>
          </div>
          <DatabaseUnavailable title="News Unavailable" />
        </div>
      </main>
    );
  }

  const allTags = [...new Set(allPosts.flatMap((p) => p.tags || []))].sort()

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Longhorn Sim Racing News",
    numberOfItems: allPosts.length,
    itemListElement: allPosts.map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `https://www.longhornsimracing.org/news/${p.slug}`,
      name: p.title,
    })),
  };

  const posts = allPosts.filter((p) => {
    const searchMatch = !q ||
      p.title.toLowerCase().includes(q.toLowerCase()) ||
      p.excerpt?.toLowerCase().includes(q.toLowerCase()) ||
      p.author?.toLowerCase().includes(q.toLowerCase())
    
    const tagMatch = selectedTags.length === 0 || 
      p.tags?.some(t => selectedTags.includes(t.toLowerCase()))

    return searchMatch && tagMatch
  })

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />
      <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
          <div>
            <h1 className="font-display font-black italic text-5xl md:text-6xl text-white uppercase tracking-normal">
              Team <span className="text-lsr-orange">News</span>
            </h1>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-2">Latest Updates & Reports</p>
          </div>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <NewsSearch q={q} />
            <NewsFilters allTags={allTags} selectedTags={selectedTags} />
          </div>
        </div>

        <Separator className="my-8 bg-white/10" />

        {posts.length === 0 && (
          <div className="border border-white/10 bg-white/[0.02] p-12 text-center">
            <p className="font-sans font-bold text-white/40 uppercase tracking-widest text-sm">No articles found matching your criteria.</p>
          </div>
        )}

        <div className="grid gap-6">
          {posts.map((p) => (
            <Link key={p.slug} href={`/news/${p.slug}`} className="group block border-l-4 border-transparent hover:border-lsr-orange bg-white/[0.03] p-8 transition-all duration-300 hover:bg-white/[0.05]">
              <div className="flex flex-col md:flex-row md:items-baseline justify-between gap-4 mb-4">
                <div className="flex flex-col gap-2">
                  {p.tags && p.tags.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {p.tags.map(tag => (
                        <span key={tag} className="text-[9px] font-black uppercase tracking-widest text-lsr-orange bg-lsr-orange/10 px-2 py-0.5 w-fit">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <h2 className="font-sans font-bold text-2xl md:text-3xl text-white uppercase tracking-tight group-hover:text-lsr-orange transition-colors">
                    {p.title}
                  </h2>
                </div>
                <time className="font-sans font-bold text-xs text-white/40 uppercase tracking-widest shrink-0">
                  {new Date(p.date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
                </time>
              </div>
              
              {p.excerpt && <p className="font-sans text-sm text-white/70 leading-relaxed max-w-3xl">{p.excerpt}</p>}
              
              <div className="flex items-center justify-between mt-6 pt-6 border-t border-white/5">
                <div className="font-sans font-bold text-[10px] uppercase tracking-widest text-white/30">
                  {p.author ? `Transmission: ${p.author}` : "Official Communiqué"}
                </div>
                <div className="flex items-center gap-2 text-lsr-orange font-sans font-black text-[10px] uppercase tracking-[0.2em] group-hover:translate-x-2 transition-transform">
                  Read Report <span className="text-lg leading-none">→</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  )
}
