import Image from "next/image"
import Link from "next/link"
import { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { ArrowRight, ArrowUpRight, CalendarDays, Check, Flag, MessageSquare, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CloudinaryImage } from "@/components/cloudinary-image"
import { LogoTile } from "@/components/logo-tile"
import { RacingNumber } from "@/components/racing-number"
import { AgendaRow } from "@/components/events/agenda-row"
import { NextUp } from "@/components/events/next-up"
import { CreateAccountButton } from "@/app/about/create-account-button"
import { PostCard } from "@/app/news/post-card"
import { InstagramFeed } from "@/app/news/instagram-feed"
import { initials } from "@/app/drivers/names"
import { getAllPosts } from "@/lib/news"
import { GOLD_SPONSORS, sponsorHref } from "@/lib/sponsors"
import { getSystemSetting, SETTINGS, type HotlapSettings } from "@/lib/email/settings"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { getClubStats } from "@/server/queries/club-stats"
import { getSchedule } from "@/server/queries/schedule"
import { getAllTimeLeaders } from "@/server/queries/roster"
import { getLoneStarCupSnapshot } from "@/server/queries/lone-star-cup"
import { getGalleryHighlights } from "@/server/queries/gallery"
import { getInstagramFeed } from "@/server/queries/instagram"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Longhorn Sim Racing | UT Austin Simulation Racing",
  description: "The official sim racing organization at UT Austin. Compete in competitive leagues, join community events, and connect with fellow motorsports enthusiasts.",
  alternates: {
    canonical: "/",
  },
}

const DISCORD_URL = "https://discord.gg/5Uv9YwpnFz"

const TICKER = [
  "100+ Discord Members",
  "Weekly Events",
  "iRacing",
  "Assetto Corsa",
  "Driver Development",
  "Watch Parties",
  "F1 Fan Community",
  "Open Practices",
  "In-House League",
  "Collegiate Racing",
  "Competitive Events",
  "Racing Rivalries",
  "Telemetry Analysis",
  "Automotive Engineering",
  "IRL Motorsports",
]

const PILLARS = [
  {
    label: "01. Compete",
    text: "League races, endurance, and time trials.",
    href: "/lone-star-cup",
    photo: "gallery/lone-star-cup-season-2/lsc2suzuka",
  },
  {
    label: "02. Develop",
    text: "Coaching, telemetry reviews, and hotlap labs.",
    href: "/drivers",
    photo: "gallery/lsr-x-wcsr/img-0172",
  },
  {
    label: "03. Community",
    text: "Sim nights, workshops, and campus meetups.",
    href: "/events",
    photo: "gallery/sim-night-race-club/img-9999",
  },
]

const HOTLAP_DEFAULTS: HotlapSettings = {
  videoUrl: "https://www.youtube.com/watch?v=fbS2ExGupLU",
  driverName: "Bryan Reyes",
  car: "GT-M Hyperion V8 (GT3)",
  track: "Daytona International",
  lapTime: "1:46.043",
}

const ghostButton =
  "h-12 rounded-none border border-white/20 bg-lsr-charcoal/40 px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal"
const primaryButton =
  "h-12 rounded-none bg-lsr-orange px-7 font-sans text-xs font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal"

/** A YouTube video id from watch, youtu.be and embed links */
function youTubeId(url: string) {
  try {
    const u = new URL(url)
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) return u.searchParams.get("v")
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null
    if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null
  } catch {}
  return null
}

/** Each loader fails on its own, so one bad query doesn't take the whole homepage down */
async function safe<T>(label: string, load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load()
  } catch (error) {
    unstable_rethrow(error)
    console.error(`[Home] Failed to load ${label}:`, error)
    return fallback
  }
}

function SectionHeading({ kicker, children, id, aside }: { kicker: string; children: React.ReactNode; id?: string; aside?: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-24 mb-8 md:mb-12 flex flex-col md:flex-row md:items-end justify-between gap-4">
      <div>
        <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-3">{kicker}</p>
        <h2 className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal leading-[0.95]">{children}</h2>
      </div>
      {aside}
    </div>
  )
}

function MoreLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex w-fit items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-lsr-orange transition-colors"
    >
      {children}
      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
    </Link>
  )
}

function Avatar({ name, src, size }: { name: string; src: string | null | undefined; size: number }) {
  return (
    <span className="relative block shrink-0 overflow-hidden border border-white/10 bg-black" style={{ width: size, height: size }}>
      {src ? (
        <Image src={src} alt="" fill sizes={`${size}px`} className="object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-display font-black italic text-white/25" style={{ fontSize: size / 3 }}>
          {initials(name)}
        </span>
      )}
    </span>
  )
}

export default async function Home() {
  const session = await safe("session", () => getCachedSessionUser(), { user: null, roles: [] as string[] })
  const viewer = session.user

  const [schedule, stats, lsc, leaders, hotlap, posts, instagram, photos] = await Promise.all([
    safe("events", () => getSchedule(viewer?.id ?? null), []),
    safe("stats", () => getClubStats(), null),
    safe("Lone Star Cup", () => getLoneStarCupSnapshot(), null),
    safe("leaders", () => getAllTimeLeaders(5), []),
    safe("hotlap", () => getSystemSetting<HotlapSettings>(SETTINGS.HOTLAP), null),
    safe("posts", () => getAllPosts(), []),
    safe("Instagram", () => getInstagramFeed(4), []),
    safe("gallery", () => getGalleryHighlights(5), []),
  ])

  const ahead = schedule.filter((e) => !e.ended && e.state !== "cancelled" && e.state !== "postponed")
  const next = ahead.find((e) => e.state === "live") ?? ahead[0] ?? null
  const comingUp = ahead.filter((e) => e !== next).slice(0, 3)
  const nextRound = ahead.find((e) => e.familyKey === "lone-star-cup") ?? null

  const hot = hotlap ?? HOTLAP_DEFAULTS
  const videoId = youTubeId(hot.videoUrl) ?? "fbS2ExGupLU"

  const statItems = [
    stats && { value: stats.members, label: "Members" },
    stats && { value: stats.eventsHosted, label: "Events hosted" },
    { value: ahead.length, label: "On the calendar" },
    lsc && { value: lsc.seasons, label: lsc.seasons === 1 ? "Lone Star Cup season" : "Lone Star Cup seasons" },
  ].filter((item): item is { value: number; label: string } => !!item)

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Longhorn Sim Racing",
    alternateName: "LSR",
    url: "https://www.longhornsimracing.org/",
  }

  return (
    <main className="bg-lsr-charcoal text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />

      {/* Hero */}
      <section className="relative flex min-h-[100svh] flex-col overflow-hidden border-b border-white/10">
        <div className="absolute inset-0 z-0">
          <Image src="/images/lsr-hero3.webp" alt="" fill preload sizes="100vw" className="object-cover object-[60%_center] opacity-60" />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/80 via-lsr-charcoal/30 to-lsr-charcoal" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal/95 via-lsr-charcoal/60 to-transparent" />
        </div>
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />

        <div className="relative z-10 flex flex-1 items-center">
          <div className={`mx-auto w-full max-w-6xl px-6 md:px-8 pt-24 pb-16 md:pt-32 md:pb-24 ${next ? "xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)] xl:items-center xl:gap-14" : ""}`}>
            <div>
              <p className="inline-flex items-center gap-2 border border-lsr-orange/30 bg-lsr-orange/10 px-3 py-1.5 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange">
                <span className="h-1.5 w-1.5 rounded-full bg-lsr-orange motion-safe:animate-pulse" />
                Established 2025 · UT Austin
              </p>
              <h1 className="mt-7 font-display font-black italic uppercase tracking-normal leading-[0.85] text-6xl sm:text-7xl md:text-8xl drop-shadow-[0_0_30px_rgba(255,255,255,0.15)]">
                Longhorn
                <span className="block text-lsr-orange">Sim Racing</span>
              </h1>
              <p className="mt-5 font-sans font-bold text-[11px] md:text-sm uppercase tracking-[0.35em] text-white/55">University of Texas at Austin</p>
              <p className="mt-7 max-w-xl font-sans text-base md:text-xl font-bold leading-relaxed text-white/85">
                UT Austin&apos;s sim racing club. Race in our own championship, get faster with people who&apos;ve been there, and meet
                everyone who loves cars as much as you do.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <Button asChild className={primaryButton}>
                  <a href="#join-the-grid">
                    <Flag className="mr-2 h-4 w-4" />
                    Join the grid
                  </a>
                </Button>
                <Button asChild className={ghostButton}>
                  <Link href="/sponsors">Sponsor LSR</Link>
                </Button>
              </div>
            </div>
            {next && <NextUp event={next} />}
          </div>
        </div>

        {/* Ticker: two copies of the list for a seamless loop */}
        <div className="group relative z-10 overflow-hidden border-t border-white/10 bg-black/30 backdrop-blur-sm" aria-label="What we do">
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-lsr-charcoal to-transparent md:w-24" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-lsr-charcoal to-transparent md:w-24" />
          <div className="flex w-max animate-[lsr-ticker_40s_linear_infinite] group-hover:[animation-play-state:paused] motion-reduce:animate-none">
            {[0, 1].map((copy) => (
              <ul key={copy} aria-hidden={copy === 1} className="flex shrink-0 items-center gap-8 whitespace-nowrap px-4 py-3.5">
                {TICKER.map((item) => (
                  <li key={item} className="flex items-center gap-8 font-display font-black italic text-sm md:text-base uppercase tracking-wide text-lsr-orange">
                    {item}
                    <span className="h-1 w-1 rounded-full bg-white/40" aria-hidden />
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>
      </section>

      {/* Stats */}
      {statItems.length > 0 && (
        <section aria-label="LSR in numbers" className="border-b border-white/10 bg-black/25">
          <dl className={`mx-auto grid max-w-6xl grid-cols-2 ${statItems.length === 4 ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
            {statItems.map((stat, i) => (
              <div
                key={stat.label}
                className={`flex flex-col-reverse px-6 py-6 md:px-8 md:py-8 ${i % 2 === 1 ? "border-l border-white/10" : ""} ${i >= 2 ? "border-t border-white/10 md:border-t-0" : ""} ${i === 2 ? "md:border-l" : ""}`}
              >
                <dt className="mt-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">{stat.label}</dt>
                <dd className="font-display font-black italic text-4xl md:text-5xl leading-none text-white">{stat.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-16 md:py-24 space-y-24 md:space-y-32">
        {/* What we do */}
        <section>
          <SectionHeading kicker="What we do">
            Race, learn, <span className="text-lsr-orange">hang out</span>
          </SectionHeading>
          <div className="grid gap-3 md:grid-cols-3 md:gap-4">
            {PILLARS.map((pillar) => (
              <Link
                key={pillar.label}
                href={pillar.href}
                className="group relative flex min-h-56 flex-col justify-between overflow-hidden border border-white/10 p-6 md:min-h-96 md:p-7"
              >
                <CloudinaryImage
                  publicId={pillar.photo}
                  alt=""
                  fill
                  sizes="(min-width: 768px) 33vw, 100vw"
                  className="object-cover opacity-50 transition-all duration-700 group-hover:scale-105 group-hover:opacity-70"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal via-lsr-charcoal/50 to-lsr-charcoal/20" />
                <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange transition-all duration-500 group-hover:w-full" />
                <h3 className="relative font-sans font-bold text-sm uppercase tracking-widest text-white/70 group-hover:text-lsr-orange transition-colors">
                  {pillar.label}
                </h3>
                <p className="relative mt-16 font-display font-black italic text-3xl uppercase leading-[0.95] text-white">{pillar.text}</p>
              </Link>
            ))}
          </div>
        </section>

        {/* Coming up */}
        <section>
          <SectionHeading kicker="On the calendar" aside={<MoreLink href="/events">Full schedule</MoreLink>}>
            Coming <span className="text-lsr-orange">up</span>
          </SectionHeading>
          {comingUp.length > 0 ? (
            <ul className="space-y-2">
              {comingUp.map((event) => (
                <AgendaRow key={event.slug} event={event} titleAs="h3" />
              ))}
            </ul>
          ) : (
            <p className="border border-white/10 bg-white/[0.02] p-8 text-center font-sans text-sm text-white/55">
              {next ? "That's everything on the calendar for now." : "Nothing on the calendar yet. New events land on Discord first."}
            </p>
          )}
        </section>

        {/* Lone Star Cup and the all-time table */}
        <section className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-[3fr_2fr]">
          <div className="relative overflow-hidden border border-white/10 bg-white/[0.02] p-6 md:p-10">
            <CloudinaryImage
              publicId="gallery/lone-star-cup-season-2/lsc2mexico"
              alt=""
              fill
              sizes="(min-width: 1024px) 660px, 100vw"
              className="object-cover opacity-20"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal via-lsr-charcoal/80 to-lsr-charcoal/40" />
            <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
            <div className="relative">
              <Image src="/images/lone-star-cup-logo.png" alt="Lone Star Cup" width={509} height={218} className="h-auto w-44 md:w-56" />
              {lsc ? (
                <>
                  <p className="mt-6 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">
                    {lsc.label}
                    {lsc.term ? ` · ${lsc.term}` : ""}
                  </p>
                  <h2 className="mt-2 font-display font-black italic text-3xl md:text-4xl uppercase leading-[0.95]">
                    {nextRound?.round ? (
                      <>
                        {nextRound.round.name} <span className="text-lsr-orange">{nextRound.round.track}</span>
                      </>
                    ) : lsc.rounds > 0 && lsc.completed === lsc.rounds ? (
                      <>
                        Season <span className="text-lsr-orange">complete</span>
                      </>
                    ) : (
                      <>
                        The club <span className="text-lsr-orange">championship</span>
                      </>
                    )}
                  </h2>
                  {nextRound && <p className="mt-2 font-sans text-sm text-white/65">{nextRound.date} · {nextRound.time}</p>}
                  {lsc.rounds > 0 && (
                    <div className="mt-6 max-w-md">
                      <div className="flex gap-1" aria-hidden>
                        {Array.from({ length: lsc.rounds }, (_, i) => (
                          <span
                            key={i}
                            className={`h-2 flex-1 -skew-x-[20deg] ${i < lsc.completed ? "bg-lsr-orange" : i === lsc.completed ? "bg-white/50" : "bg-white/10"}`}
                          />
                        ))}
                      </div>
                      <p className="mt-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">
                        {lsc.completed} of {lsc.rounds} rounds run
                      </p>
                    </div>
                  )}
                  <div className="mt-7">
                    <p className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">Season leaders</p>
                    {lsc.leaders.length > 0 ? (
                      <ol className="mt-3 space-y-2">
                        {lsc.leaders.map((entry, i) => (
                          <li key={entry.driver.id || i} className="flex items-center gap-3">
                            <span className={`w-6 font-display font-black italic text-xl ${i === 0 ? "text-lsr-orange" : "text-white/40"}`}>{i + 1}</span>
                            <Avatar name={entry.driver.name} src={entry.driver.avatarUrl} size={32} />
                            {entry.driver.handle ? (
                              <Link href={`/drivers/${entry.driver.handle}`} className="min-w-0 flex-1 truncate font-sans font-bold text-sm uppercase tracking-tight hover:text-lsr-orange">
                                {entry.driver.name}
                              </Link>
                            ) : (
                              <span className="min-w-0 flex-1 truncate font-sans font-bold text-sm uppercase tracking-tight">{entry.driver.name}</span>
                            )}
                            <span className="shrink-0 font-sans font-bold text-[10px] uppercase tracking-[0.15em] text-white/55">{entry.points} pts</span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="mt-2 font-sans text-sm text-white/55">Standings show up once results are posted.</p>
                    )}
                  </div>
                </>
              ) : (
                <p className="mt-6 font-sans text-base text-white/65">LSR&apos;s own championship: a full season of races, one grid, and points toward the title.</p>
              )}
              <Button asChild className={`mt-8 ${primaryButton}`}>
                <Link href="/lone-star-cup">
                  Lone Star Cup
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="flex flex-col border border-white/10 bg-white/[0.02] p-6 md:p-8">
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Every season, every point</p>
            <h2 className="mt-2 font-display font-black italic text-3xl md:text-4xl uppercase leading-[0.95]">
              All-time <span className="text-lsr-orange">leaders</span>
            </h2>
            {leaders.length > 0 ? (
              <ol className="mt-6 flex-1 divide-y divide-white/5">
                {leaders.map((driver) => (
                  <li key={driver.id}>
                    <Link href={`/drivers/${driver.handle}`} className="group flex items-center gap-3 py-3">
                      <span className={`w-7 font-display font-black italic text-2xl ${driver.rank === 1 ? "text-lsr-orange" : "text-white/30"}`}>{driver.rank}</span>
                      <Avatar name={driver.displayName} src={driver.avatarUrl} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-sans font-bold text-sm uppercase tracking-tight group-hover:text-lsr-orange transition-colors">
                          {driver.displayName}
                        </span>
                        <span className="block truncate font-sans text-[11px] text-white/40">
                          {driver.wins > 0 ? `${driver.wins} ${driver.wins === 1 ? "win" : "wins"} · ` : ""}
                          {driver.seasons} {driver.seasons === 1 ? "season" : "seasons"}
                        </span>
                      </span>
                      <RacingNumber user={driver} size="xs" />
                      <span className="w-12 shrink-0 text-right font-display font-black italic text-2xl">{driver.points}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-6 flex-1 font-sans text-sm text-white/55">Points show up here once race results are uploaded.</p>
            )}
            <div className="mt-6">
              <MoreLink href="/drivers#standings">Full standings</MoreLink>
            </div>
          </div>
        </section>

        {/* Hotlap of the week (set in Admin → Hotlap) */}
        <section id="hotlap" className="scroll-mt-24 grid overflow-hidden border border-white/10 bg-white/[0.02] lg:grid-cols-[3fr_2fr]">
          <div className="relative aspect-video bg-black">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&loop=1&playlist=${videoId}&controls=0&modestbranding=1&playsinline=1`}
              title={`Hotlap of the week: ${hot.driverName} at ${hot.track}`}
              loading="lazy"
              allow="autoplay; encrypted-media; picture-in-picture"
              className="absolute inset-0 h-full w-full"
            />
          </div>
          <div className="relative flex flex-col justify-center p-6 md:p-10">
            <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Hotlap of the week</p>
            <p className="mt-3 font-display font-black italic text-6xl md:text-7xl leading-none text-white">{hot.lapTime}</p>
            <h2 className="mt-4 font-display font-black italic text-2xl md:text-3xl uppercase leading-tight">{hot.driverName}</h2>
            <dl className="mt-4 space-y-1 font-sans text-sm text-white/65">
              <div className="flex gap-2">
                <dt className="sr-only">Car</dt>
                <dd>{hot.car}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="sr-only">Track</dt>
                <dd>{hot.track}</dd>
              </div>
            </dl>
            <a
              href={`https://www.youtube.com/watch?v=${videoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group mt-7 inline-flex w-fit items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-lsr-orange transition-colors"
            >
              <Play className="h-3.5 w-3.5" />
              Watch with sound on YouTube
              <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
        </section>

        {/* News, or Instagram until there's news */}
        {posts.length > 0 ? (
          <section>
            <SectionHeading kicker="From the paddock" aside={<MoreLink href="/news">All news</MoreLink>}>
              Latest <span className="text-lsr-orange">news</span>
            </SectionHeading>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {posts.slice(0, 3).map((post) => (
                <PostCard key={post.slug} post={post} />
              ))}
            </div>
          </section>
        ) : (
          instagram.length > 0 && <InstagramFeed posts={instagram} />
        )}

        {/* Gallery */}
        {photos.length > 0 && (
          <section>
            <SectionHeading kicker="Moments from the track" aside={<MoreLink href="/gallery">Photos and videos</MoreLink>}>
              The <span className="text-lsr-orange">gallery</span>
            </SectionHeading>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:grid-rows-2 md:gap-3">
              {photos.map((photo, i) => (
                <Link
                  key={photo.id}
                  href={`/gallery?album=${encodeURIComponent(photo.album)}#albums`}
                  className={`group relative overflow-hidden border border-white/10 bg-black ${i === 0 ? "col-span-2 aspect-video md:row-span-2 md:aspect-auto" : "aspect-[4/3]"}`}
                >
                  <CloudinaryImage
                    publicId={photo.publicId}
                    alt={photo.alt ?? ""}
                    fill
                    sizes={i === 0 ? "(min-width: 768px) 50vw, 100vw" : "(min-width: 768px) 25vw, 50vw"}
                    className="object-cover opacity-85 transition-all duration-700 group-hover:scale-105 group-hover:opacity-100"
                  />
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2.5 pt-8 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/85">
                    {photo.albumTitle}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Partners: Gold and up appear here (see src/lib/sponsors.ts) */}
        {GOLD_SPONSORS.length > 0 && (
          <section>
            <SectionHeading kicker="Backed by" aside={<MoreLink href="/sponsors">Become a partner</MoreLink>}>
              Our <span className="text-lsr-orange">partners</span>
            </SectionHeading>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 md:gap-4">
              {GOLD_SPONSORS.map((sponsor) => (
                <LogoTile
                  key={sponsor.name}
                  name={sponsor.name}
                  logo={sponsor.logo}
                  title={sponsor.title}
                  sizes="(min-width: 640px) 30vw, 85vw"
                  href={sponsor.url ? sponsorHref(sponsor.url, "sponsor-homepage") : "/sponsors"}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Join the grid */}
      <section id="join-the-grid" className="relative scroll-mt-20 overflow-hidden border-t border-white/10">
        <div className="absolute inset-0 z-0">
          <CloudinaryImage publicId="gallery/cota-track-day/img-1058" alt="" fill sizes="100vw" className="object-cover object-[center_30%] opacity-40" />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/90 via-lsr-charcoal/75 to-lsr-charcoal" />
        </div>
        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 py-20 md:py-28">
          <div className="max-w-2xl">
            <h2 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9]">
              Join the <span className="text-lsr-orange">grid</span>
            </h2>
            <p className="mt-4 font-sans font-bold text-[11px] uppercase tracking-[0.3em] text-white/55">Start your first session this week</p>
          </div>
          <ol className="mt-12 grid gap-3 md:grid-cols-3 md:gap-4">
            <li className="flex flex-col border border-white/10 bg-lsr-charcoal/70 p-6 backdrop-blur-sm md:p-8">
              <span className="font-display font-black italic text-4xl text-lsr-orange">01</span>
              <h3 className="mt-4 font-sans font-bold text-lg uppercase tracking-tight text-white">Driver Registration</h3>
              <p className="mt-3 flex-1 font-sans text-sm leading-relaxed text-white/60">
                Forge your digital identity and track your progress. Create your profile and get on the official roster.
              </p>
              <div className="mt-8">
                {viewer ? (
                  <Button asChild className="h-12 rounded-none border border-white/15 bg-white/5 px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
                    <Link href={`/drivers/${viewer.handle}`}>
                      <Check className="mr-2 h-3.5 w-3.5 text-lsr-orange" />
                      Roster confirmed
                    </Link>
                  </Button>
                ) : (
                  <CreateAccountButton />
                )}
              </div>
            </li>
            <li className="flex flex-col border border-white/10 bg-lsr-charcoal/70 p-6 backdrop-blur-sm md:p-8">
              <span className="font-display font-black italic text-4xl text-lsr-orange">02</span>
              <h3 className="mt-4 font-sans font-bold text-lg uppercase tracking-tight text-white">The Paddock</h3>
              <p className="mt-3 flex-1 font-sans text-sm leading-relaxed text-white/60">
                Join our Discord for real-time announcements, race coordination, and member-only discussions.
              </p>
              <div className="mt-8">
                <Button asChild className="h-12 rounded-none bg-lsr-orange px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
                  <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
                    <MessageSquare className="mr-2 h-3.5 w-3.5" />
                    Join Discord
                  </a>
                </Button>
              </div>
            </li>
            <li className="flex flex-col border border-white/10 bg-lsr-charcoal/70 p-6 backdrop-blur-sm md:p-8">
              <span className="font-display font-black italic text-4xl text-lsr-orange">03</span>
              <h3 className="mt-4 font-sans font-bold text-lg uppercase tracking-tight text-white">Green Light</h3>
              <p className="mt-3 flex-1 font-sans text-sm leading-relaxed text-white/60">
                Check the schedule and join an upcoming practice or race session to prove your mettle on track.
              </p>
              <div className="mt-8">
                <Button asChild className="h-12 rounded-none bg-lsr-orange px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
                  <Link href="/events">
                    <CalendarDays className="mr-2 h-3.5 w-3.5" />
                    View Schedule
                  </Link>
                </Button>
              </div>
            </li>
          </ol>
          <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3">
            <MoreLink href="/lone-star-cup">Race the Lone Star Cup</MoreLink>
            <MoreLink href="/gallery">See the club in photos</MoreLink>
            <MoreLink href="/about">Meet the officers</MoreLink>
          </div>
        </div>
      </section>
    </main>
  )
}
