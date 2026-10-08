import Link from "next/link"
import Image from "next/image"
import { Metadata } from "next"
import { ArrowRight, ArrowUpRight, Instagram, MessageSquare, Rss, Twitch } from "lucide-react"
import { getAllPosts } from "@/lib/news"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { CloudinaryImage } from "@/components/cloudinary-image"
import { NewsSearch } from "@/components/news-search"
import { DatabaseUnavailable } from "@/components/database-unavailable"
import { getNextEventForHomepage } from "@/server/queries/events"
import { getLatestGalleryAlbum } from "@/server/queries/gallery"
import { FeaturedPost, PostCard } from "./post-card"

export const metadata: Metadata = {
  title: "Team News",
  description: "Latest updates, race reports, and announcements from Longhorn Sim Racing.",
  alternates: {
    canonical: "/news",
  },
};

export const revalidate = 60 // revalidate list once per min

const INSTAGRAM_URL = "https://instagram.com/longhorn_sim_racing"
const DISCORD_URL = "https://discord.gg/5Uv9YwpnFz"
const TWITCH_URL = "https://www.twitch.tv/longhorn_sim_racing"

const CHANNELS = [
  { label: "Instagram", detail: "Photos and reels from every event", href: INSTAGRAM_URL, icon: Instagram },
  { label: "Discord", detail: "Where the club talks day to day", href: DISCORD_URL, icon: MessageSquare },
  { label: "Twitch", detail: "Watch our races live", href: TWITCH_URL, icon: Twitch },
  { label: "RSS", detail: "New posts in your feed reader", href: "/news/subscribe", icon: Rss },
]

/** The next event and newest album for the "Around the club" cards; either is null if it can't load. */
async function getClubTeasers() {
  const [event, album] = await Promise.all([
    getNextEventForHomepage()
      .then((events) => events[0] ?? null)
      .catch((error) => {
        console.error("[News] Failed to load next event:", error)
        return null
      }),
    getLatestGalleryAlbum().catch((error) => {
      console.error("[News] Failed to load latest album:", error)
      return null
    }),
  ])
  return { event, album }
}

function SectionHeading({ kicker, children }: { kicker: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-3">{kicker}</p>
      <h2 className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal leading-[0.95]">
        {children}
      </h2>
    </div>
  )
}

function TeaserCard({
  href,
  kicker,
  title,
  detail,
  image,
}: {
  href: string
  kicker: string
  title: string
  detail: string
  image: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className="group relative flex min-h-[300px] flex-col justify-end overflow-hidden border border-white/10 transition-colors hover:border-lsr-orange/50"
    >
      {image}
      <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal via-lsr-charcoal/75 via-45% to-lsr-charcoal/10" />
      <div className="relative p-6">
        <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">{kicker}</p>
        <h3 className="mt-2 font-display font-black italic text-2xl md:text-3xl text-white uppercase tracking-normal leading-tight">
          {title}
        </h3>
        <p className="mt-2 font-sans text-sm text-white/65">{detail}</p>
        <span className="mt-5 inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white group-hover:text-lsr-orange transition-colors">
          Take a look
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
        </span>
      </div>
    </Link>
  )
}

const imageClass = "object-cover opacity-70 transition-all duration-500 group-hover:scale-105 group-hover:opacity-90"

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

  let allPosts: Awaited<ReturnType<typeof getAllPosts>>
  let teasers: Awaited<ReturnType<typeof getClubTeasers>>
  try {
    ;[allPosts, teasers] = await Promise.all([getAllPosts(), getClubTeasers()])
  } catch (error) {
    console.error('[News] Failed to load posts:', error);
    return (
      <main className="bg-lsr-charcoal text-white min-h-screen">
        <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
          <h1 className="mb-10 font-display font-black italic text-5xl md:text-6xl text-white uppercase tracking-normal">
            Team <span className="text-lsr-orange">News</span>
          </h1>
          <DatabaseUnavailable title="News Unavailable" />
        </div>
      </main>
    );
  }

  const allTags = [...new Set(allPosts.flatMap((p) => p.tags || []))].sort()
  const filtering = q !== "" || selectedTags.length > 0

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
  // The newest post leads the page unless a search or topic is narrowing the list
  const featured = filtering ? undefined : posts[0]
  const rest = filtering ? posts : posts.slice(1)

  function tagHref(tag: string | null) {
    const params = new URLSearchParams()
    if (q) params.set("q", q)
    if (tag) params.set("tag", tag)
    const query = params.toString()
    return query ? `/news?${query}` : "/news"
  }

  const { event, album } = teasers
  const eventLive = event ? new Date(event.startsAtUtc) <= new Date() : false
  const albumPhoto = album?.images[0]

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />

      {/* Hero */}
      <div className="relative border-b border-white/10 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <CloudinaryImage
            publicId="gallery/wec-at-cota-2025/img-0414"
            alt=""
            fill
            sizes="100vw"
            preload
            className="object-cover object-[center_60%] opacity-60"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/70 via-lsr-charcoal/30 to-lsr-charcoal" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal/80 via-lsr-charcoal/30 to-transparent" />
        </div>
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />

        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 pt-24 pb-14 md:pt-36 md:pb-20">
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-4">From the paddock</p>
          <h1 className="font-display font-black italic text-5xl md:text-8xl text-white uppercase tracking-normal leading-[0.9]">
            Team <span className="text-lsr-orange">News</span>
          </h1>
          <p className="mt-6 max-w-2xl font-sans text-base md:text-xl font-bold text-white/80 leading-relaxed">
            Race reports, announcements and club updates from Longhorn Sim Racing.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/news/subscribe"
              className="inline-flex items-center gap-2 border border-white/15 bg-lsr-charcoal/40 px-4 h-10 font-sans font-bold text-[10px] uppercase tracking-widest hover:bg-white hover:text-lsr-charcoal transition-colors"
            >
              <Rss className="h-3.5 w-3.5" />
              Subscribe
            </Link>
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 border border-white/15 bg-lsr-charcoal/40 px-4 h-10 font-sans font-bold text-[10px] uppercase tracking-widest hover:bg-white hover:text-lsr-charcoal transition-colors"
            >
              <Instagram className="h-3.5 w-3.5" />
              @longhorn_sim_racing
            </a>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-12 md:py-20 space-y-24 md:space-y-32">
        {allPosts.length > 0 ? (
          <section aria-label="Posts">
            <div className="flex flex-col-reverse md:flex-row md:items-center justify-between gap-4 mb-8 md:mb-10 border-b border-white/10 pb-6">
              <nav aria-label="Topics" className="flex flex-wrap gap-2">
                <Link
                  href={tagHref(null)}
                  className={`px-3 py-1.5 font-sans font-bold text-[10px] uppercase tracking-widest border transition-colors ${
                    selectedTags.length === 0 ? "border-lsr-orange bg-lsr-orange text-white" : "border-white/15 text-white/60 hover:border-white/40 hover:text-white"
                  }`}
                >
                  All
                </Link>
                {allTags.map((tag) => {
                  const active = selectedTags.includes(tag.toLowerCase())
                  return (
                    <Link
                      key={tag}
                      href={tagHref(active ? null : tag)}
                      className={`px-3 py-1.5 font-sans font-bold text-[10px] uppercase tracking-widest border transition-colors ${
                        active ? "border-lsr-orange bg-lsr-orange text-white" : "border-white/15 text-white/60 hover:border-white/40 hover:text-white"
                      }`}
                    >
                      {tag}
                    </Link>
                  )
                })}
              </nav>
              <NewsSearch q={q} />
            </div>

            {posts.length === 0 ? (
              <div className="border border-white/10 bg-white/[0.02] p-10 md:p-14 text-center">
                <p className="font-display font-black italic text-2xl md:text-3xl uppercase">
                  No posts <span className="text-lsr-orange">match</span>
                </p>
                <p className="mt-3 font-sans text-sm text-white/50">Try another search or topic.</p>
                <Link
                  href="/news"
                  className="mt-6 inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white transition-colors"
                >
                  Show all posts
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            ) : (
              <div className="space-y-4 md:space-y-6">
                {featured && <FeaturedPost post={featured} />}
                {rest.length > 0 && (
                  <div className="grid gap-4 md:gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {rest.map((post) => (
                      <PostCard key={post.slug} post={post} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        ) : (
          <section className="relative overflow-hidden border border-white/10 bg-white/[0.02] p-8 md:p-14">
            <div className="absolute top-0 left-0 h-1 w-full bg-gradient-to-r from-lsr-orange via-lsr-orange/40 to-transparent" />
            <div className="absolute -bottom-24 -right-24 h-64 w-64 rounded-full bg-lsr-orange/10 blur-[100px] pointer-events-none" />
            <div className="relative max-w-2xl">
              <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/40">Nothing posted yet</p>
              <h2 className="mt-3 font-display font-black italic text-4xl md:text-6xl text-white uppercase tracking-normal leading-[0.95]">
                The first story is <span className="text-lsr-orange">on its way</span>
              </h2>
              <p className="mt-5 font-sans text-white/60 text-base md:text-lg leading-relaxed">
                Race reports, announcements and club news will land here. Until then, here&apos;s what&apos;s happening around LSR.
              </p>
            </div>
          </section>
        )}

        {/* Around the club */}
        <section>
          <div className="mb-10 md:mb-12">
            <SectionHeading kicker="Meanwhile">
              Around the <span className="text-lsr-orange">club</span>
            </SectionHeading>
          </div>
          <div className="grid gap-4 md:gap-6 md:grid-cols-3">
            {event ? (
              <TeaserCard
                href={`/events/${event.slug}`}
                kicker={eventLive ? "Live now" : "Next event"}
                title={event.title}
                detail={[
                  new Date(event.startsAtUtc).toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    timeZone: event.timezone || DEFAULT_TIMEZONE,
                  }),
                  event.venue?.name,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                image={
                  event.heroImageUrl ? (
                    <Image src={event.heroImageUrl} alt="" fill sizes="(min-width: 768px) 33vw, 100vw" className={imageClass} />
                  ) : (
                    <CloudinaryImage
                      publicId="gallery/race-club-austin/00000366"
                      alt=""
                      fill
                      sizes="(min-width: 768px) 33vw, 100vw"
                      className={imageClass}
                    />
                  )
                }
              />
            ) : (
              <TeaserCard
                href="/events"
                kicker="Events"
                title="The calendar"
                detail="Race nights, track days and socials."
                image={
                  <CloudinaryImage
                    publicId="gallery/race-club-austin/00000366"
                    alt=""
                    fill
                    sizes="(min-width: 768px) 33vw, 100vw"
                    className={imageClass}
                  />
                }
              />
            )}
            <TeaserCard
              href="/lone-star-cup"
              kicker="Lone Star Cup"
              title="Standings and results"
              detail="Season 3 of our in-house league."
              image={
                <CloudinaryImage
                  publicId="gallery/lone-star-cup-season-2/lsc2spa"
                  alt=""
                  fill
                  sizes="(min-width: 768px) 33vw, 100vw"
                  className={imageClass}
                />
              }
            />
            <TeaserCard
              href={album ? `/gallery?album=${album.slug}` : "/gallery"}
              kicker={album ? "Latest album" : "Gallery"}
              title={album ? album.title : "The gallery"}
              detail={
                album?.date
                  ? new Date(album.date).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
                  : "Shot by LSR Media."
              }
              image={
                albumPhoto ? (
                  <CloudinaryImage publicId={albumPhoto.publicId} alt="" fill sizes="(min-width: 768px) 33vw, 100vw" className={imageClass} />
                ) : (
                  <Image src="/images/gal_05.JPG" alt="" fill sizes="(min-width: 768px) 33vw, 100vw" className={imageClass} />
                )
              }
            />
          </div>
        </section>

        {/* Channels */}
        <section>
          <div className="grid gap-6 md:grid-cols-[1fr_1fr] md:items-end mb-10 md:mb-12">
            <SectionHeading kicker="Stay in the loop">
              Follow <span className="text-lsr-orange">along</span>
            </SectionHeading>
            <p className="font-sans text-white/60 text-base md:text-lg leading-relaxed">
              Most of what happens at LSR shows up on our socials first.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
            {CHANNELS.map((channel) => {
              const external = channel.href.startsWith("http")
              return (
                <a
                  key={channel.label}
                  href={channel.href}
                  {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  className="group relative flex flex-col border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-lsr-orange/50 hover:bg-white/[0.04]"
                >
                  <ArrowUpRight className="absolute top-4 right-4 h-4 w-4 text-white/20 transition-colors group-hover:text-lsr-orange" />
                  <channel.icon className="h-6 w-6 text-lsr-orange" />
                  <p className="mt-6 font-sans font-black text-sm uppercase tracking-[0.15em] text-white">{channel.label}</p>
                  <p className="mt-1 font-sans text-xs text-white/50">{channel.detail}</p>
                </a>
              )
            })}
          </div>
        </section>
      </div>
    </main>
  )
}
