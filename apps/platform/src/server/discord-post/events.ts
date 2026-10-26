import { EventStatus, type Prisma } from "@prisma/client"
import { isEventPublic, publicEventWhere } from "@/lib/events"
import type { EventForPost } from "./templates"

/**
 * Which of the club's events the standing rules and the event mirror may post about (design §12.1):
 * public ones only (`isEventPublic`: published, or scheduled and past its publish time, with public
 * visibility), and not cancelled or postponed. What they read is what's public about an event; the
 * select below never includes its meeting link (meetingUrl).
 */

export const EVENT_SELECT = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  startsAtUtc: true,
  endsAtUtc: true,
  status: true,
  visibility: true,
  publishedAt: true,
  updatedAt: true,
  registrationEnabled: true,
  registrationClosesAt: true,
  series: { select: { slug: true } },
  venue: { select: { name: true, room: true } },
} satisfies Prisma.EventSelect

export type EventRow = Prisma.EventGetPayload<{ select: typeof EVENT_SELECT }>

export function forPost(event: EventRow): EventForPost {
  return {
    slug: event.slug,
    title: event.title,
    summary: event.summary,
    startsAtUtc: event.startsAtUtc,
    endsAtUtc: event.endsAtUtc,
    venue: event.venue ? { name: event.venue.name, room: event.venue.room } : null,
    registrationEnabled: event.registrationEnabled,
    registrationClosesAt: event.registrationClosesAt,
  }
}

/** Why an event can't be posted about (not public, cancelled, postponed, another series), or null */
export function eventProblem(event: Pick<EventRow, "status" | "visibility" | "publishedAt" | "series">, now: Date, series?: string | null): string | null {
  if (!isEventPublic(event, now)) return "isn't public on the site"
  if (event.status === EventStatus.CANCELLED) return "was cancelled"
  if (event.status === EventStatus.POSTPONED) return "was postponed"
  if (series && event.series?.slug !== series) return "isn't in the rule's series"
  return null
}

/** The database side of eventProblem, plus `extra`: public, not a draft, cancelled or postponed, in the series */
export function postableEvents(now: Date, series: string | null | undefined, extra: Prisma.EventWhereInput): Prisma.EventWhereInput {
  return { AND: [publicEventWhere(now), { status: { notIn: [EventStatus.CANCELLED, EventStatus.POSTPONED, EventStatus.DRAFT] } }, ...(series ? [{ series: { slug: series } }] : []), extra] }
}
