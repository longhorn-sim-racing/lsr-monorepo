"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Search, Trophy, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { StatusIcons } from "@/components/status-indicators"
import { getStatusIndicators } from "@/lib/status-indicators"
import { RacingNumber } from "@/components/racing-number"
import type { RosterDriver } from "@/server/queries/roster"
import { byName, initials } from "./names"

/** How many cards show before "Show all", when nothing is searched or filtered */
const PREVIEW = 24

const FILTERS = [
  { key: "all", label: "Everyone", match: () => true },
  {
    key: "officer",
    label: "Officers",
    match: (d: RosterDriver) => !!d.officerTitle || d.roles.includes("officer") || d.roles.includes("admin"),
  },
  { key: "lsc_driver", label: "Lone Star Cup", match: (d: RosterDriver) => d.lsc },
  { key: "collegiate_driver", label: "Collegiate", match: (d: RosterDriver) => d.roles.includes("collegiate_driver") },
  { key: "alumni", label: "Alumni", match: (d: RosterDriver) => d.tierKey === "ALUMNI" },
] as const

const SORTS = [
  { key: "name", label: "A–Z" },
  { key: "points", label: "Points" },
  { key: "number", label: "Car no." },
] as const

type FilterKey = (typeof FILTERS)[number]["key"]
type SortKey = (typeof SORTS)[number]["key"]

export function Roster({ drivers }: { drivers: RosterDriver[] }) {
  const params = useSearchParams()
  const [query, setQuery] = useState(params.get("q") ?? "")
  const [filter, setFilter] = useState<FilterKey>(() => {
    const role = params.get("role")
    return FILTERS.find((f) => f.key === role)?.key ?? "all"
  })
  const [sort, setSort] = useState<SortKey>(() => SORTS.find((s) => s.key === params.get("sort"))?.key ?? "name")
  const [expanded, setExpanded] = useState(false)
  const list = useRef<HTMLUListElement>(null)

  // Keep the URL shareable without a server round trip per keystroke
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    sp.delete("q")
    sp.delete("role")
    sp.delete("sort")
    if (query.trim()) sp.set("q", query.trim())
    if (filter !== "all") sp.set("role", filter)
    if (sort !== "name") sp.set("sort", sort)
    const search = sp.toString()
    const url = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      // null state (as in the gallery) so Next's router takes the new URL as its own
      window.history.replaceState(null, "", url)
    }
  }, [query, filter, sort])

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, drivers.filter(f.match).length])) as Record<FilterKey, number>,
    [drivers],
  )

  const shown = useMemo(() => {
    const q = query.trim().replace(/^@/, "").toLowerCase()
    const match = FILTERS.find((f) => f.key === filter)!.match
    const matches = drivers.filter(
      (d) => match(d) && (!q || d.displayName.toLowerCase().includes(q) || d.handle.toLowerCase().includes(q)),
    )
    const nameOrder = (a: RosterDriver, b: RosterDriver) => byName(a.displayName, b.displayName)
    if (sort === "name") matches.sort(nameOrder)
    if (sort === "points") matches.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || nameOrder(a, b))
    if (sort === "number") matches.sort((a, b) => (a.racingNumber ?? Infinity) - (b.racingNumber ?? Infinity) || nameOrder(a, b))
    return matches
  }, [drivers, query, filter, sort])

  const narrowed = !!query.trim() || filter !== "all"
  const visible = expanded || narrowed ? shown : shown.slice(0, PREVIEW)

  return (
    <div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-sm">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or handle"
            aria-label="Search drivers"
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
        <div className="flex items-center gap-1 self-start lg:self-auto" role="group" aria-label="Sort drivers">
          <span className="mr-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/40">Sort</span>
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={sort === s.key}
              onClick={() => setSort(s.key)}
              className={cn(
                "h-9 px-3 font-sans font-bold text-[10px] uppercase tracking-[0.15em] transition-colors",
                sort === s.key ? "bg-white text-lsr-charcoal" : "text-white/60 hover:text-white",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* One swipeable row on phones */}
      <div
        className="-mx-6 mt-5 flex gap-2 overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
        role="group"
        aria-label="Filter drivers"
      >
        {FILTERS.filter((f) => f.key === "all" || counts[f.key] > 0).map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-2 border px-3.5 font-sans font-bold text-[10px] uppercase tracking-[0.15em] transition-colors",
              filter === f.key
                ? "border-lsr-orange bg-lsr-orange text-white"
                : "border-white/15 text-white/70 hover:border-white/40 hover:text-white",
            )}
          >
            {f.label}
            <span className={filter === f.key ? "text-white/75" : "text-white/35"}>{counts[f.key]}</span>
          </button>
        ))}
      </div>

      <p className="mt-6 font-sans text-[11px] text-white/40" aria-live="polite">
        {narrowed ? `${shown.length} of ${drivers.length} drivers` : `${drivers.length} ${drivers.length === 1 ? "driver" : "drivers"}`}
      </p>

      {shown.length === 0 ? (
        <div className="mt-3 border border-white/10 bg-white/[0.02] p-10 text-center">
          <p className="font-sans text-sm text-white/60">
            No drivers match{query.trim() ? ` “${query.trim()}”` : " that filter"}.
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery("")
              setFilter("all")
            }}
            className="mt-4 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white"
          >
            Clear search and filters
          </button>
        </div>
      ) : (
        <ul ref={list} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((driver) => (
            <li key={driver.id}>
              <DriverCard driver={driver} />
            </li>
          ))}
        </ul>
      )}

      {!narrowed && !expanded && shown.length > PREVIEW && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => {
              setExpanded(true)
              // The button goes away, so move focus to the first newly shown driver
              requestAnimationFrame(() => list.current?.querySelectorAll("a")[PREVIEW]?.focus())
            }}
            className="h-12 border border-white/20 px-8 font-sans font-bold text-[10px] uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-lsr-charcoal"
          >
            Show all {shown.length} drivers
          </button>
        </div>
      )}
    </div>
  )
}

function DriverCard({ driver }: { driver: RosterDriver }) {
  const indicators = getStatusIndicators({
    roles: driver.roles,
    activeTierKey: driver.tierKey,
    officerTitle: driver.officerTitle,
  })

  return (
    <div className="group relative flex h-full items-center gap-4 border border-white/10 bg-white/[0.02] p-3 pr-4 transition-colors hover:border-lsr-orange/60 hover:bg-white/[0.04] has-[a:focus-visible]:border-lsr-orange has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-lsr-orange">
      <div className="relative h-14 w-14 shrink-0 overflow-hidden border border-white/10 bg-black">
        {driver.avatarUrl ? (
          <Image src={driver.avatarUrl} alt="" fill sizes="56px" className="object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center font-display font-black italic text-lg text-white/25">
            {initials(driver.displayName)}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <Link
          href={`/drivers/${driver.handle}`}
          className="block truncate font-sans font-bold text-sm uppercase tracking-tight text-white outline-hidden transition-colors after:absolute after:inset-0 group-hover:text-lsr-orange"
        >
          {driver.displayName}
        </Link>
        <p className="truncate font-sans text-[11px] text-white/40">@{driver.handle}</p>
        {(indicators.length > 0 || driver.titles.length > 0 || driver.pending) && (
          // Above the card-wide link so the icons' tooltips still work; only as wide as its badges, so
          // the rest of the row still opens the profile
          <div className="relative z-10 mt-1.5 flex w-fit flex-wrap items-center gap-1.5">
            {driver.titles.map((title, i) => (
              <span
                key={`${title}-${i}`}
                className="inline-flex items-center gap-1 bg-lsr-orange/15 px-1.5 py-0.5 font-sans font-bold text-[9px] uppercase tracking-[0.15em] text-lsr-orange"
              >
                <Trophy className="h-2.5 w-2.5" aria-hidden />
                {title} champ
              </span>
            ))}
            {driver.pending && (
              <span className="border border-red-900 bg-red-900/50 px-1.5 py-0.5 font-sans font-bold text-[8px] uppercase tracking-widest text-red-200">
                Unverified
              </span>
            )}
            <StatusIcons indicators={indicators} />
          </div>
        )}
      </div>
      <div className="shrink-0 text-right">
        <RacingNumber user={driver} size="sm" />
        {driver.points > 0 && (
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.15em] text-white/45">{driver.points} pts</p>
        )}
      </div>
    </div>
  )
}
