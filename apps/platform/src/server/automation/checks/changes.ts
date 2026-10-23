import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { missingResultsWhere } from "@/lib/events"
import { prisma } from "@/server/db"
import type { DigestCheck, DigestCheckResult } from "../types"

/**
 * Digest and Overview "needs attention" checks from the changes track (design §11.2): results not
 * uploaded, draft events coming up, and events with low registration. Items name the event and link to
 * where an officer fixes it. Added by the automation track (T11), since this track had none.
 */

const DAY_MS = 86_400_000
const ITEMS = 5
const day = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "EEE, MMM d")
const inDays = (n: number) => (n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`)

/** Draft events starting within this many days need publishing (or deleting) */
export const DRAFT_AHEAD_DAYS = 14
/** A draft whose date passed within this many days is still listed: it was likely meant to go up */
export const DRAFT_PASSED_DAYS = 14
/** Events starting within this many days count for low registration */
export const LOW_REGISTRATION_AHEAD_DAYS = 7
/** Registered below this share of the cap is low */
export const LOW_REGISTRATION_SHARE = 0.5

/** Ended racing events with no ingested results: the Overview's "Results missing" rule */
export const resultsMissing: DigestCheck = {
  id: "results.missing",
  label: "Race results not uploaded",
  href: "/admin/results",
  order: 30,
  async run({ now }): Promise<DigestCheckResult> {
    const where = missingResultsWhere(now)
    const [count, events] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({
        where,
        orderBy: { endsAtUtc: "asc" },
        take: ITEMS,
        select: { id: true, title: true, endsAtUtc: true, rawResultUploads: { select: { id: true }, orderBy: { uploadedAt: "desc" }, take: 1 } },
      }),
    ])
    return {
      count,
      // A week after the race the results are late
      severity: events.some((event) => now.getTime() - event.endsAtUtc.getTime() > 7 * DAY_MS) ? "warning" : "info",
      items: events.map((event) => {
        const upload = event.rawResultUploads[0]
        return {
          title: event.title,
          href: upload ? `/admin/results/${upload.id}` : "/admin/results?upload=1",
          detail: `${upload ? "Uploaded, not ingested" : "No upload"} · ended ${day(event.endsAtUtc)}`,
        }
      }),
    }
  },
}

/** Draft events starting in the next two weeks (they're hidden until published), and drafts whose date just passed */
export const draftEvents: DigestCheck = {
  id: "events.drafts",
  label: "Draft events coming up",
  href: "/admin/events",
  order: 31,
  async run({ now }): Promise<DigestCheckResult> {
    const where = { status: "DRAFT" as const, startsAtUtc: { gte: new Date(now.getTime() - DRAFT_PASSED_DAYS * DAY_MS), lte: new Date(now.getTime() + DRAFT_AHEAD_DAYS * DAY_MS) } }
    const [count, events] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({ where, orderBy: { startsAtUtc: "asc" }, take: 50, select: { id: true, title: true, startsAtUtc: true } }),
    ])
    const ahead = (start: Date) => Math.ceil((start.getTime() - now.getTime()) / DAY_MS)
    // Upcoming first (soonest first), then the ones whose date passed
    const upcoming = events.filter((event) => event.startsAtUtc >= now)
    const passed = events.filter((event) => event.startsAtUtc < now).reverse()
    return {
      count,
      severity: upcoming.some((event) => ahead(event.startsAtUtc) <= 7) ? "warning" : "info",
      items: [...upcoming, ...passed].slice(0, ITEMS).map((event) => ({
        title: event.title,
        href: `/admin/events/${event.id}/edit`,
        detail: event.startsAtUtc >= now ? `Still a draft · starts ${day(event.startsAtUtc)} (${inDays(ahead(event.startsAtUtc))})` : `Still a draft · its date passed ${day(event.startsAtUtc)}`,
      })),
    }
  },
}

/**
 * Published events starting in the next week, with registration on and a cap, that have fewer than half
 * their spots taken (registered, not waitlisted)
 */
export const lowRegistration: DigestCheck = {
  id: "events.low-registration",
  label: "Events with low registration",
  href: "/admin/events",
  order: 32,
  async run({ now }): Promise<DigestCheckResult> {
    const events = await prisma.event.findMany({
      where: {
        startsAtUtc: { gt: now, lte: new Date(now.getTime() + LOW_REGISTRATION_AHEAD_DAYS * DAY_MS) },
        registrationEnabled: true,
        registrationMax: { gt: 0 },
        OR: [{ status: "PUBLISHED" }, { status: "SCHEDULED", publishedAt: { lte: now } }],
      },
      orderBy: { startsAtUtc: "asc" },
      take: 50,
      select: { id: true, title: true, startsAtUtc: true, registrationMax: true },
    })
    if (!events.length) return { count: 0, severity: "info", items: [] }
    const counts = await prisma.eventRegistration.groupBy({ by: ["eventId"], where: { eventId: { in: events.map((e) => e.id) }, status: "REGISTERED" }, _count: { _all: true } })
    const registered = new Map(counts.map((row) => [row.eventId, row._count._all]))
    const low = events
      .map((event) => ({ event, taken: registered.get(event.id) ?? 0, max: event.registrationMax! }))
      .filter(({ taken, max }) => taken < max * LOW_REGISTRATION_SHARE)
    const ahead = (start: Date) => Math.ceil((start.getTime() - now.getTime()) / DAY_MS)
    return {
      count: low.length,
      // Two days out and under a quarter full: worth a push now
      severity: low.some(({ event, taken, max }) => ahead(event.startsAtUtc) <= 2 && taken < max / 4) ? "warning" : "info",
      items: low.slice(0, ITEMS).map(({ event, taken, max }) => ({
        title: `${event.title}: ${taken} of ${max} registered`,
        href: `/admin/events/${event.id}/manage`,
        detail: `Starts ${day(event.startsAtUtc)} (${inDays(ahead(event.startsAtUtc))})`,
      })),
    }
  },
}

export const CHECKS: DigestCheck[] = [resultsMissing, draftEvents, lowRegistration]
