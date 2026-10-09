import { EventStatus } from "@prisma/client"
import { prisma } from "@/server/db"
import { publicEventWhere, isEventLive } from "@/lib/events"
import { publicUserSelect } from "@/lib/public-user"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { parseRoundTitle } from "@/lib/rounds"
import { slugify } from "@/lib/slug"

/**
 * One event on the public schedule. Everything here ends up in the page's HTML, so public fields
 * only: no internal description (see #46), meeting links, registration internals or the event's
 * id (QR check-in is keyed on it). Dates are formatted on the server in the event's own time
 * zone, so the server and every browser agree.
 */
export type ScheduleEvent = {
  slug: string
  title: string
  summary: string | null
  photo: string | null
  /** e.g. "Lone Star Cup S3" */
  series: string | null
  /** The series without its season, e.g. "Lone Star Cup"; what the filter chips use */
  family: string
  familyKey: string
  /** League rounds: "Round 5" at "Long Beach" */
  round: { name: string; track: string; note: string | null; night: boolean; final: boolean } | null
  /** "October 2026" */
  month: string
  /** "Sat" and "10", for the date plate */
  weekday: string
  day: string
  /** "Sat, Oct 10, 2026" */
  date: string
  /** "10:00 AM – 12:00 PM CT" */
  time: string
  /** "Tomorrow", "In 3 days"; upcoming events only */
  startsIn: string | null
  /** "Fall 2026" */
  term: string
  venue: string | null
  place: string | null
  mapsUrl: string | null
  online: boolean
  state: "live" | "upcoming" | "past" | "cancelled" | "postponed"
  /** Over (cancelled and postponed events too), so it belongs in the archive rather than the agenda */
  ended: boolean
  registration: "open" | "waitlist" | "full" | "soon" | "closed" | null
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

/** Whole calendar days from `now` to `date`, counted in the event's time zone */
function calendarDays(date: Date, now: Date, timeZone: string) {
  const day = (d: Date) => Date.parse(d.toLocaleDateString("en-CA", { timeZone }))
  return Math.round((day(date) - day(now)) / 86_400_000)
}

function startsIn(start: Date, now: Date, timeZone: string) {
  const hours = (start.getTime() - now.getTime()) / 3_600_000
  if (hours < 1) return "Starting soon"
  const days = calendarDays(start, now, timeZone)
  if (days > 1) return `In ${days} days`
  if (days === 1) return "Tomorrow"
  return `In ${Math.round(hours)} ${Math.round(hours) === 1 ? "hour" : "hours"}`
}

function termOf(date: Date, timeZone: string) {
  const month = Number(format(date, timeZone, { month: "numeric" }))
  const year = format(date, timeZone, { year: "numeric" })
  return `${month <= 5 ? "Spring" : month <= 7 ? "Summer" : "Fall"} ${year}`
}

/**
 * League rounds ("… Round 5 @ Long Beach", "… FINAL Round @ Fuji", "… Finale @ Monaco") get a
 * round name and track; everything else keeps its own title.
 */
function roundOf(title: string, series: { slug: string } | null) {
  if (!series || !title.includes("@")) return null
  const finale = /\bfinale\b/i.test(title)
  if (!/\bRound\s+\d|\bfinal\s+round\b/i.test(title) && !finale) return null
  const round = parseRoundTitle(title, 0)
  const isFinale = finale && !/\bRound\s+\d/i.test(title)
  return {
    name: isFinale ? "Finale" : round.name,
    track: round.track,
    note: round.note,
    night: round.night,
    final: round.final || isFinale,
  }
}

function registrationOf(
  event: {
    registrationEnabled: boolean
    registrationOpensAt: Date | null
    registrationClosesAt: Date | null
    registrationMax: number | null
    registrationWaitlistEnabled: boolean
    registrationFeeCents: number | null
    endsAtUtc: Date
  },
  counts: { registered: number; waitlisted: number },
  now: Date,
): ScheduleEvent["registration"] {
  // Mirrors the event page's registration window (api/events/[slug]/registration)
  if (!event.registrationEnabled || now > event.endsAtUtc) return null
  if (event.registrationOpensAt && now < event.registrationOpensAt) return "soon"
  if (event.registrationClosesAt && now > event.registrationClosesAt) return "closed"
  // And its capacity rules (registration.service, payment.service): an event is full at its max.
  // A free event with people already waiting also sends new sign-ups to the back of the line; a
  // paid one lets new payers take a freed spot (its waitlist is promoted by hand)
  if (event.registrationMax === null) return "open"
  const paid = (event.registrationFeeCents ?? 0) > 0
  const full =
    counts.registered >= event.registrationMax || (!paid && event.registrationWaitlistEnabled && counts.waitlisted > 0)
  if (!full) return "open"
  return event.registrationWaitlistEnabled ? "waitlist" : "full"
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
      registrationMax: true,
      registrationWaitlistEnabled: true,
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

  // Sign-up counts for events that still take registrations (the event page shows these publicly)
  const open = events.filter((e) => e.registrationEnabled && e.registrationMax !== null && e.endsAtUtc >= now).map((e) => e.id)
  const [counts, registrations] = await Promise.all([
    open.length
      ? prisma.eventRegistration.groupBy({
          by: ["eventId", "status"],
          where: { eventId: { in: open }, status: { in: ["REGISTERED", "WAITLISTED"] } },
          _count: true,
        })
      : [],
    viewerId
      ? prisma.eventRegistration.findMany({
          where: { userId: viewerId, status: { in: ["REGISTERED", "WAITLISTED"] }, event: { endsAtUtc: { gte: now } } },
          select: { eventId: true, status: true },
        })
      : [],
  ])
  const countOf = (eventId: string, status: "REGISTERED" | "WAITLISTED") =>
    counts.find((c) => c.eventId === eventId && c.status === status)?._count ?? 0
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
    const family = familyOf(event.series)
    return {
      slug: event.slug,
      title: event.title,
      summary: event.summary?.trim() || null,
      photo: event.heroImageUrl || null,
      series: event.series?.title ?? null,
      family,
      familyKey: slugify(family),
      round: roundOf(event.title, event.series),
      month: format(start, tz, { month: "long", year: "numeric" }),
      weekday: format(start, tz, { weekday: "short" }),
      day: format(start, tz, { day: "numeric" }),
      date: format(start, tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
      time: timeRange(start, event.endsAtUtc, tz),
      startsIn: state === "upcoming" ? startsIn(start, now, tz) : null,
      term: termOf(start, tz),
      venue: event.venue?.name ?? null,
      place: [event.venue?.city, event.venue?.state].filter(Boolean).join(", ") || null,
      mapsUrl: event.venue?.googleMapsUrl || null,
      online: /virtual|online/i.test(event.venue?.name ?? ""),
      state,
      ended: event.endsAtUtc < now,
      registration:
        state === "cancelled" || state === "postponed"
          ? null
          : registrationOf(event, { registered: countOf(event.id, "REGISTERED"), waitlisted: countOf(event.id, "WAITLISTED") }, now),
      feeCents: event.registrationFeeCents,
      viewer: status === "REGISTERED" ? "registered" : status === "WAITLISTED" ? "waitlisted" : null,
      winner: winner ? { name: winner.user?.displayName || winner.displayName, handle: winner.user?.handle ?? null } : null,
      album: event.galleryAlbums[0]?.slug ?? null,
      streamUrl: event.streamUrl || null,
    }
  })
}
