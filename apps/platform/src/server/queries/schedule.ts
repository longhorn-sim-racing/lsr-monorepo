import { EventStatus } from "@prisma/client"
import { prisma } from "@/server/db"
import { publicEventWhere, isEventLive } from "@/lib/events"
import { publicUserSelect } from "@/lib/public-user"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { parseRoundTitle } from "@/lib/rounds"

/**
 * One event on the public schedule. Everything here ends up in the page's HTML, so public fields
 * only: no internal description (see #46), meeting links or registration internals. Dates are
 * formatted on the server in the event's own time zone, so the server and every browser agree.
 */
export type ScheduleEvent = {
  id: string
  slug: string
  title: string
  summary: string | null
  photo: string | null
  /** e.g. "Lone Star Cup S3" */
  series: string | null
  /** The series without its season, e.g. "Lone Star Cup"; what the filter chips use */
  family: string
  /** League rounds: "Round 5" at "Long Beach" */
  round: { name: string; track: string; note: string | null; night: boolean; final: boolean } | null
  startsAt: string
  /** "October 2026" */
  month: string
  /** "Sat" and "10", for the date plate */
  weekday: string
  day: string
  /** "Sat, Oct 10, 2026" */
  date: string
  /** "10:00 AM – 12:00 PM CT" */
  time: string
  /** "Fall 2026" */
  term: string
  venue: string | null
  place: string | null
  mapsUrl: string | null
  online: boolean
  state: "live" | "upcoming" | "past" | "cancelled" | "postponed"
  /** Over (cancelled and postponed events too), so it belongs in the archive rather than the agenda */
  ended: boolean
  registration: "open" | "soon" | "closed" | null
  feeCents: number | null
  /** The signed-in viewer's own registration */
  viewer: "registered" | "waitlisted" | null
  winner: { name: string; handle: string | null } | null
  /** Gallery album slug, when the event has photos in the gallery */
  album: string | null
  streamUrl: string | null
}

const OTHER_FAMILY = "Club events"

/** "Lone Star Cup S3" → "Lone Star Cup", "Formula Sunday League Season 2" → "Formula Sunday League" */
function familyOf(series: { title: string; slug: string } | null) {
  if (!series) return OTHER_FAMILY
  if (series.slug.includes("lone-star-cup")) return "Lone Star Cup"
  return series.title.replace(/\s+(S|Season\s*)\d+$/i, "").trim() || series.title
}

/** "CT" rather than CDT/CST, which flips mid-season when daylight saving ends */
function zoneLabel(date: Date, timeZone: string) {
  if (timeZone === "America/Chicago") return "CT"
  return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? ""
}

function format(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions) {
  return date.toLocaleString("en-US", { ...options, timeZone })
}

function timeRange(start: Date, end: Date, timeZone: string) {
  const time = (date: Date) => format(date, timeZone, { hour: "numeric", minute: "2-digit" })
  const sameDay = format(start, timeZone, { dateStyle: "short" }) === format(end, timeZone, { dateStyle: "short" })
  const endLabel = sameDay ? time(end) : `${format(end, timeZone, { month: "short", day: "numeric" })}, ${time(end)}`
  return `${time(start)} – ${endLabel} ${zoneLabel(start, timeZone)}`.trim()
}

function termOf(date: Date, timeZone: string) {
  const month = Number(format(date, timeZone, { month: "numeric" }))
  const year = format(date, timeZone, { year: "numeric" })
  return `${month <= 5 ? "Spring" : month <= 7 ? "Summer" : "Fall"} ${year}`
}

/** League rounds get a round name and track; one-offs keep their own title */
function roundOf(title: string, series: { slug: string } | null) {
  if (!series || !title.includes("@")) return null
  // "Formula Sunday League Finale @ Monaco"
  if (/\bfinale\b/i.test(title) && !/\bRound\s+\d/i.test(title)) {
    return { name: "Finale", track: title.split("@").pop()!.trim(), note: null, night: false, final: true }
  }
  if (!/\bRound\s+\d|\bfinal\b/i.test(title)) return null
  const round = parseRoundTitle(title, 0)
  return { name: round.name, track: round.track, note: round.note, night: round.night, final: round.final }
}

function registrationOf(
  event: { registrationEnabled: boolean; registrationOpensAt: Date | null; registrationClosesAt: Date | null; endsAtUtc: Date },
  now: Date,
): ScheduleEvent["registration"] {
  // Mirrors the event page's registration window (api/events/[slug]/registration)
  if (!event.registrationEnabled || now > event.endsAtUtc) return null
  if (event.registrationOpensAt && now < event.registrationOpensAt) return "soon"
  if (event.registrationClosesAt && now > event.registrationClosesAt) return "closed"
  return "open"
}

export async function getSchedule(viewerId: string | null) {
  const now = new Date()
  const events = await prisma.event.findMany({
    where: publicEventWhere(now),
    orderBy: { startsAtUtc: "asc" },
    select: {
      id: true,
      slug: true,
      title: true,
      summary: true,
      heroImageUrl: true,
      startsAtUtc: true,
      endsAtUtc: true,
      timezone: true,
      status: true,
      publishedAt: true,
      streamUrl: true,
      registrationEnabled: true,
      registrationOpensAt: true,
      registrationClosesAt: true,
      registrationFeeCents: true,
      series: { select: { title: true, slug: true } },
      venue: { select: { name: true, city: true, state: true, googleMapsUrl: true } },
      galleryAlbums: { select: { slug: true }, where: { images: { some: {} } }, take: 1 },
      ingestedSessions: {
        where: { sessionType: "RACE", results: { some: {} } },
        orderBy: { startedAt: "desc" },
        take: 1,
        select: {
          results: {
            where: { position: 1 },
            take: 1,
            select: { participant: { select: { displayName: true, user: { select: publicUserSelect } } } },
          },
        },
      },
    },
  })

  const registrations = viewerId
    ? await prisma.eventRegistration.findMany({
        where: { userId: viewerId, status: { in: ["REGISTERED", "WAITLISTED"] }, event: { endsAtUtc: { gte: now } } },
        select: { eventId: true, status: true },
      })
    : []
  const viewerStatus = new Map(registrations.map((r) => [r.eventId, r.status]))

  return events.map((event): ScheduleEvent => {
    const tz = event.timezone || DEFAULT_TIMEZONE
    const start = event.startsAtUtc
    const winner = event.ingestedSessions[0]?.results[0]?.participant
    const state: ScheduleEvent["state"] =
      event.status === EventStatus.CANCELLED
        ? "cancelled"
        : event.status === EventStatus.POSTPONED
          ? "postponed"
          : isEventLive(event)
            ? "live"
            : event.endsAtUtc < now
              ? "past"
              : "upcoming"
    const status = viewerStatus.get(event.id)
    return {
      id: event.id,
      slug: event.slug,
      title: event.title,
      summary: event.summary?.trim() || null,
      photo: event.heroImageUrl || null,
      series: event.series?.title ?? null,
      family: familyOf(event.series),
      round: roundOf(event.title, event.series),
      startsAt: start.toISOString(),
      month: format(start, tz, { month: "long", year: "numeric" }),
      weekday: format(start, tz, { weekday: "short" }),
      day: format(start, tz, { day: "numeric" }),
      date: format(start, tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
      time: timeRange(start, event.endsAtUtc, tz),
      term: termOf(start, tz),
      venue: event.venue?.name ?? null,
      place: [event.venue?.city, event.venue?.state].filter(Boolean).join(", ") || null,
      mapsUrl: event.venue?.googleMapsUrl || null,
      online: /virtual|online/i.test(event.venue?.name ?? ""),
      state,
      ended: event.endsAtUtc < now,
      registration: state === "cancelled" || state === "postponed" ? null : registrationOf(event, now),
      feeCents: event.registrationFeeCents,
      viewer: status === "REGISTERED" ? "registered" : status === "WAITLISTED" ? "waitlisted" : null,
      winner: winner ? { name: winner.user?.displayName || winner.displayName, handle: winner.user?.handle ?? null } : null,
      album: event.galleryAlbums[0]?.slug ?? null,
      streamUrl: event.streamUrl || null,
    }
  })
}
