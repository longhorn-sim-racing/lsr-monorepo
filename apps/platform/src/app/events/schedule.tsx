"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { ArrowRight, Check, Clock, Images, MapPin, Monitor, Moon, Search, Trophy, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ScheduleEvent } from "@/server/queries/schedule"

/** Past events shown before "Show all", when nothing is searched or filtered */
const ARCHIVE_PREVIEW = 9

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`

/** Groups in order of first appearance */
function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return [...groups]
}

function Heading({ kicker, children, id, aside }: { kicker: string; children: React.ReactNode; id: string; aside?: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-24 mb-8 md:mb-10 flex flex-col md:flex-row md:items-end justify-between gap-3">
      <div>
        <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-3">{kicker}</p>
        <h2 className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal leading-[0.95]">{children}</h2>
      </div>
      {aside}
    </div>
  )
}

function EventTitle({ event }: { event: ScheduleEvent }) {
  if (!event.round) return <>{event.title}</>
  return (
    <>
      {event.round.name} <span className="text-lsr-orange">{event.round.track}</span>
    </>
  )
}

/** The small labels above an event's title */
function Tags({ event }: { event: ScheduleEvent }) {
  const tag = "inline-flex items-center gap-1 px-1.5 py-0.5 font-sans font-bold text-[9px] uppercase tracking-[0.15em]"
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/50 mr-1">{event.series ?? event.family}</span>
      {event.state === "live" && (
        <span className={`${tag} bg-red-600 text-white`}>
          <span className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" /> Live now
        </span>
      )}
      {event.state === "cancelled" && <span className={`${tag} bg-red-900/60 text-red-200`}>Cancelled</span>}
      {event.state === "postponed" && <span className={`${tag} bg-amber-900/50 text-amber-200`}>Postponed</span>}
      {event.viewer === "registered" && (
        <span className={`${tag} bg-emerald-900/50 text-emerald-200`}>
          <Check className="h-2.5 w-2.5" aria-hidden /> You&apos;re in
        </span>
      )}
      {event.viewer === "waitlisted" && <span className={`${tag} bg-white/10 text-white/80`}>Waitlisted</span>}
      {event.round?.night && (
        <span className={`${tag} bg-white/10 text-white/80`}>
          <Moon className="h-2.5 w-2.5" aria-hidden /> {event.round.note}
        </span>
      )}
      {event.round?.final && <span className={`${tag} bg-lsr-orange text-white`}>Finale</span>}
    </div>
  )
}

function Where({ event, className }: { event: ScheduleEvent; className?: string }) {
  if (!event.venue) return null
  const Icon = event.online ? Monitor : MapPin
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-lsr-orange" aria-hidden />
      <span className="truncate">
        {event.venue}
        {event.place && !event.online ? ` · ${event.place}` : ""}
      </span>
    </span>
  )
}

function AgendaRow({ event }: { event: ScheduleEvent }) {
  const off = event.state === "cancelled" || event.state === "postponed"
  const watch = event.state === "live" && !!event.streamUrl
  const register = event.registration === "open" && !event.viewer
  const soon = event.registration === "soon"
  return (
    <li>
      <div
        className={cn(
          "group relative overflow-hidden border transition-colors has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-lsr-orange",
          event.state === "live" ? "border-red-600/60 bg-red-600/[0.06]" : "border-white/10 bg-white/[0.02] hover:border-lsr-orange/50",
        )}
      >
        {event.photo && (
          <div aria-hidden className="absolute inset-y-0 right-0 hidden w-2/5 md:block">
            <Image src={event.photo} alt="" fill sizes="460px" className="object-cover opacity-40 transition-opacity duration-500 group-hover:opacity-60" />
            <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal via-lsr-charcoal/60 to-transparent" />
          </div>
        )}
        <div className="relative grid grid-cols-[56px_minmax(0,1fr)] items-center gap-4 p-4 md:grid-cols-[72px_minmax(0,1fr)_auto] md:gap-6 md:p-5">
          <div className={cn("flex flex-col items-center justify-center border-r border-white/10 pr-4 md:pr-6", off && "opacity-50")}>
            <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange">{event.weekday}</span>
            <span className="font-display font-black italic text-4xl md:text-5xl leading-none text-white">{event.day}</span>
          </div>
          <div className="min-w-0">
            <Tags event={event} />
            <h3 className={cn("mt-1.5 font-display font-black italic text-xl md:text-2xl uppercase leading-tight text-white", off && "line-through decoration-white/40")}>
              <Link href={`/events/${event.slug}`} className="outline-hidden after:absolute after:inset-0 group-hover:text-white">
                <EventTitle event={event} />
              </Link>
            </h3>
            <div className="mt-2 flex flex-col gap-1 font-sans text-xs text-white/60 sm:flex-row sm:flex-wrap sm:gap-x-5">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 shrink-0 text-lsr-orange" aria-hidden />
                {event.time}
              </span>
              <Where event={event} />
            </div>
            {event.summary && !event.round && <p className="mt-2 hidden max-w-xl font-sans text-xs text-white/45 line-clamp-1 md:block">{event.summary}</p>}
          </div>
          {/* On phones this sits under the details, and only when there's something to act on */}
          <div
            className={cn(
              "col-span-2 items-center justify-between gap-3 border-t border-white/5 pt-3 md:col-span-1 md:flex md:flex-col md:items-end md:border-0 md:pt-0",
              watch || register || soon ? "flex" : "hidden",
            )}
          >
            {watch ? (
              <a
                href={event.streamUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="relative z-10 inline-flex h-9 items-center gap-2 bg-red-600 px-4 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white hover:bg-white hover:text-lsr-charcoal"
              >
                Watch live
              </a>
            ) : register ? (
              <span className="inline-flex h-9 items-center bg-lsr-orange px-4 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white">
                Register{event.feeCents ? ` · ${dollars(event.feeCents)}` : ""}
              </span>
            ) : soon ? (
              <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/50">Registration soon</span>
            ) : (
              <span />
            )}
            <ArrowRight className="h-4 w-4 text-white/40 transition-all group-hover:translate-x-1 group-hover:text-lsr-orange" aria-hidden />
          </div>
        </div>
      </div>
    </li>
  )
}

function ArchiveCard({ event }: { event: ScheduleEvent }) {
  return (
    <li>
      <article className="group relative flex h-full flex-col overflow-hidden border border-white/10 bg-white/[0.02] transition-colors hover:border-lsr-orange/50 has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-lsr-orange">
        <div className="relative aspect-[16/9] overflow-hidden bg-black">
          {event.photo ? (
            <Image
              src={event.photo}
              alt=""
              fill
              sizes="(min-width: 1024px) 360px, (min-width: 640px) 50vw, 100vw"
              className="object-cover opacity-80 transition-transform duration-700 group-hover:scale-105"
            />
          ) : (
            // No photo: the series name over the site's stripe pattern
            <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.04)_0px,rgba(255,255,255,0.04)_1px,transparent_1px,transparent_10px)] p-4">
              <span className="block font-display font-black italic text-2xl uppercase leading-none text-white/10 line-clamp-2">{event.family}</span>
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-lsr-charcoal/80 via-transparent to-transparent" />
          <span className="absolute bottom-3 left-4 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/80">{event.date}</span>
        </div>
        <div className="flex flex-1 flex-col p-5">
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">
            {event.series ?? event.family}
            {event.state === "cancelled" && <span className="ml-2 text-red-300">· Cancelled</span>}
          </p>
          <h3 className="mt-2 font-display font-black italic text-xl uppercase leading-tight text-white">
            <Link href={`/events/${event.slug}`} className="outline-hidden transition-colors after:absolute after:inset-0 group-hover:text-lsr-orange">
              <EventTitle event={event} />
            </Link>
          </h3>
          {event.winner && (
            <p className="relative z-10 mt-3 inline-flex w-fit items-center gap-1.5 font-sans text-xs text-white/70">
              <Trophy className="h-3.5 w-3.5 text-lsr-orange" aria-hidden />
              Won by{" "}
              {event.winner.handle ? (
                <Link href={`/drivers/${event.winner.handle}`} className="font-bold text-white hover:text-lsr-orange">
                  {event.winner.name}
                </Link>
              ) : (
                <span className="font-bold text-white">{event.winner.name}</span>
              )}
            </p>
          )}
          <div className="mt-auto flex items-center gap-5 pt-5">
            <span className="inline-flex items-center gap-1.5 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/60 group-hover:text-white">
              Details <ArrowRight className="h-3 w-3" aria-hidden />
            </span>
            {event.album && (
              <Link
                href={`/gallery?album=${encodeURIComponent(event.album)}#albums`}
                className="relative z-10 inline-flex items-center gap-1.5 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white"
              >
                <Images className="h-3.5 w-3.5" aria-hidden /> Photos
              </Link>
            )}
          </div>
        </div>
      </article>
    </li>
  )
}

export function Schedule({ events }: { events: ScheduleEvent[] }) {
  const params = useSearchParams()
  const [query, setQuery] = useState(params.get("q") ?? "")
  const [family, setFamily] = useState(params.get("series") ?? "all")
  const [expanded, setExpanded] = useState(false)
  const archive = useRef<HTMLDivElement>(null)

  const families = useMemo(() => {
    const counts = new Map<string, number>()
    for (const event of events) counts.set(event.family, (counts.get(event.family) ?? 0) + 1)
    // Busiest first, so the racing series lead
    return [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ key: slugify(name), name, count }))
  }, [events])
  const activeFamily = families.some((f) => f.key === family) ? family : "all"

  // Keep the URL shareable without a server round trip per keystroke
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    sp.delete("q")
    sp.delete("series")
    if (query.trim()) sp.set("q", query.trim())
    if (activeFamily !== "all") sp.set("series", activeFamily)
    const search = sp.toString()
    const url = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      // null state (as in the gallery) so Next's router takes the new URL as its own
      window.history.replaceState(null, "", url)
    }
  }, [query, activeFamily])

  const { upcoming, past } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = events.filter(
      (e) =>
        (activeFamily === "all" || slugify(e.family) === activeFamily) &&
        (!q || [e.title, e.summary, e.venue, e.series].some((field) => field?.toLowerCase().includes(q))),
    )
    return {
      upcoming: matches.filter((e) => !e.ended),
      past: matches.filter((e) => e.ended).reverse(),
    }
  }, [events, query, activeFamily])

  const narrowed = !!query.trim() || activeFamily !== "all"
  const shownPast = expanded || narrowed ? past : past.slice(0, ARCHIVE_PREVIEW)
  const familyName = families.find((f) => f.key === activeFamily)?.name

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div
          className="-mx-6 flex gap-2 overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
          role="group"
          aria-label="Filter by series"
        >
          {[{ key: "all", name: "Everything", count: events.length }, ...families].map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={activeFamily === f.key}
              onClick={() => setFamily(f.key)}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-2 border px-3.5 font-sans font-bold text-[10px] uppercase tracking-[0.15em] transition-colors",
                activeFamily === f.key ? "border-lsr-orange bg-lsr-orange text-white" : "border-white/15 text-white/70 hover:border-white/40 hover:text-white",
              )}
            >
              {f.name}
              <span className={activeFamily === f.key ? "text-white/75" : "text-white/35"}>{f.count}</span>
            </button>
          ))}
        </div>
        <div className="relative w-full lg:max-w-xs">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search events"
            aria-label="Search events"
            className="h-11 w-full border border-white/15 bg-white/[0.03] pl-10 pr-10 font-sans text-sm text-white placeholder:text-white/35 outline-none transition-colors focus:border-lsr-orange [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-white/40 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Upcoming */}
      <section className="mt-14 md:mt-16" aria-live="polite">
        <Heading kicker={narrowed ? `${upcoming.length} coming up` : "What's next"} id="upcoming">
          Coming <span className="text-lsr-orange">up</span>
        </Heading>
        {upcoming.length === 0 ? (
          <p className="border border-white/10 bg-white/[0.02] p-8 text-center font-sans text-sm text-white/55">
            {narrowed
              ? `Nothing coming up${familyName ? ` in ${familyName}` : ""}${query.trim() ? ` matching “${query.trim()}”` : ""} right now.`
              : "Nothing on the calendar yet. New events land on Discord first."}
          </p>
        ) : (
          <div className="space-y-10">
            {groupBy(upcoming, (e) => e.month).map(([month, list]) => (
              <div key={month}>
                <h3 className="mb-3 flex items-baseline gap-3 font-display font-black italic text-2xl uppercase text-white/90">
                  {month}
                  <span className="font-sans not-italic font-bold text-[10px] uppercase tracking-[0.2em] text-white/35">
                    {list.length} {list.length === 1 ? "event" : "events"}
                  </span>
                </h3>
                <ul className="space-y-2">
                  {list.map((event) => (
                    <AgendaRow key={event.id} event={event} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Archive */}
      {past.length > 0 && (
        <section className="mt-24 md:mt-32">
          <Heading kicker={`${past.length} past ${past.length === 1 ? "event" : "events"}`} id="past">
            The <span className="text-lsr-orange">archive</span>
          </Heading>
          <div ref={archive} className="space-y-12">
            {groupBy(shownPast, (e) => e.term).map(([term, list]) => (
              <div key={term}>
                <h3 className="mb-4 flex items-center gap-4 font-display font-black italic text-2xl uppercase text-white/90">
                  {term}
                  <span className="h-px flex-1 bg-white/10" />
                </h3>
                <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((event) => (
                    <ArchiveCard key={event.id} event={event} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {shownPast.length < past.length && (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => {
                  setExpanded(true)
                  // The button goes away, so move focus to the first newly shown event
                  requestAnimationFrame(() => archive.current?.querySelectorAll<HTMLElement>("article h3 a")[ARCHIVE_PREVIEW]?.focus())
                }}
                className="h-12 border border-white/20 px-8 font-sans font-bold text-[10px] uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-lsr-charcoal"
              >
                Show all {past.length} past events
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
