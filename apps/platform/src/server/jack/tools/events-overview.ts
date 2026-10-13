import type { AttendanceReportingMode, EventStatus, Prisma, RegistrationStatus, Visibility } from "@prisma/client"
import { z } from "zod"
import { getEffectiveEventStatus, isEventPublic } from "@/lib/events"
import { prisma } from "@/server/db"
import { forModelWithList, plural, tableDisplay } from "./display"
import { centralDateInput, centralRange, ct, ctShort, dollars } from "./time"
import type { JackTool } from "./types"

/**
 * events_overview: events in a date range with their status, registrations, waitlist, attendance
 * and results (#161). Effective status comes from lib/events; attendance follows the event's
 * reporting mode the way the attendance service counts it.
 */

export type EventRow = {
  id: string
  title: string
  slug: string
  status: EventStatus
  visibility: Visibility
  publishedAt: Date | null
  startsAtUtc: Date
  endsAtUtc: Date
  registrationEnabled: boolean
  registrationMax: number | null
  registrationWaitlistEnabled: boolean
  registrationFeeCents: number | null
  attendanceEnabled: boolean
  attendanceReportingMode: AttendanceReportingMode
  series: { title: string } | null
  venue: { name: string } | null
  _count: { rawResultUploads: number; ingestedSessions: number }
}

type Counts = Partial<Record<RegistrationStatus, number>> & { checkedIn?: number }

/** One event as the model sees it */
export function summarizeEvent(event: EventRow, counts: Counts, now = new Date()) {
  const registered = counts.REGISTERED ?? 0
  const checkedIn = counts.checkedIn ?? 0
  // Same rule as getEventAttendanceState: check-ins count when the event takes them; otherwise everyone registered attended
  const checkInRequired = event.attendanceEnabled || event.attendanceReportingMode === "CHECKIN_REQUIRED"
  const started = event.startsAtUtc <= now
  return {
    id: event.id,
    title: event.title,
    series: event.series?.title ?? null,
    venue: event.venue?.name ?? null,
    startsAt: ct(event.startsAtUtc),
    endsAt: ct(event.endsAtUtc),
    status: event.status,
    effectiveStatus: getEffectiveEventStatus(event),
    public: isEventPublic(event, now),
    registration: {
      open: event.registrationEnabled,
      capacity: event.registrationMax,
      feeDollars: event.registrationFeeCents ? dollars(event.registrationFeeCents) : null,
      registered,
      waitlisted: counts.WAITLISTED ?? 0,
      notAttending: counts.NOT_ATTENDING ?? 0,
    },
    attendance: {
      basis: checkInRequired ? "check-ins" : "assumed: everyone registered",
      attended: started ? (checkInRequired ? checkedIn : registered) : null,
      checkedIn,
    },
    results:
      event._count.ingestedSessions > 0
        ? "results in"
        : event._count.rawResultUploads > 0
          ? "uploaded, not processed"
          : null,
    manageUrl: `/admin/events/${event.id}/manage`,
  }
}

/** Every word must appear in the title, slug or series name */
export function searchWhere(search: string | undefined): Prisma.EventWhereInput {
  const words = search?.trim().split(/\s+/).filter(Boolean) ?? []
  return words.length
    ? {
        AND: words.map((word) => ({
          OR: [
            { title: { contains: word, mode: "insensitive" as const } },
            { slug: { contains: word, mode: "insensitive" as const } },
            { series: { title: { contains: word, mode: "insensitive" as const } } },
          ],
        })),
      }
    : {}
}

const input = z.object({
  from: centralDateInput.optional().describe("First Central date (default: 14 days ago, or a year ago with search)"),
  to: centralDateInput.optional().describe("Last Central date (default: 60 days ahead, or a year ahead with search)"),
  search: z.string().max(80).optional().describe('Words that must all appear in the title, slug or series, e.g. "general meeting" or "round 4"'),
  includeDrafts: z.boolean().default(true).describe("Include DRAFT events (hidden from members)"),
  limit: z.number().int().min(1).max(100).default(40),
})

export const eventsOverviewTool: JackTool<z.infer<typeof input>> = {
  name: "events_overview",
  description:
    "Events in a date range (Central time), oldest first, each with its stored status and effective status (what members see: upcoming, in progress, completed), whether it's public, registration (capacity, registered, waitlisted, said no), attendance (check-ins, or everyone registered when the event doesn't take check-ins) and whether race results are in. Use it for 'what's on the calendar', 'is GM 1 scheduled', 'how many came to X'. Search matches words in the title.",
  input,
  async run({ from, to, search, includeDrafts, limit }) {
    const wide = search && !from && !to
    const range = centralRange({ from, to }, wide ? { fromDaysAgo: 365, toDaysAhead: 365 } : { fromDaysAgo: 14, toDaysAhead: 60 })
    if (!range.ok) return { isError: true, forModel: range.error, label: "Events lookup failed", displays: [] }

    const events: EventRow[] = await prisma.event.findMany({
      where: {
        startsAtUtc: { gte: range.start, lte: range.end },
        ...(includeDrafts ? {} : { status: { not: "DRAFT" } }),
        ...searchWhere(search),
      },
      orderBy: { startsAtUtc: "asc" },
      take: limit + 1,
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        visibility: true,
        publishedAt: true,
        startsAtUtc: true,
        endsAtUtc: true,
        registrationEnabled: true,
        registrationMax: true,
        registrationWaitlistEnabled: true,
        registrationFeeCents: true,
        attendanceEnabled: true,
        attendanceReportingMode: true,
        series: { select: { title: true } },
        venue: { select: { name: true } },
        _count: { select: { rawResultUploads: true, ingestedSessions: true } },
      },
    })
    const more = events.length > limit
    const shown = events.slice(0, limit)
    const ids = shown.map((e) => e.id)

    const [registrations, attendance] = ids.length
      ? await Promise.all([
          prisma.eventRegistration.groupBy({ by: ["eventId", "status"], where: { eventId: { in: ids } }, _count: { _all: true } }),
          prisma.eventAttendance.groupBy({ by: ["eventId"], where: { eventId: { in: ids } }, _count: { _all: true } }),
        ])
      : [[], []]

    const counts = new Map<string, Counts>()
    for (const row of registrations) counts.set(row.eventId, { ...counts.get(row.eventId), [row.status]: row._count._all })
    for (const row of attendance) counts.set(row.eventId, { ...counts.get(row.eventId), checkedIn: row._count._all })

    const now = new Date()
    const rows = shown.map((event) => summarizeEvent(event, counts.get(event.id) ?? {}, now))
    const result = {
      range: { from: range.from, to: range.to, timeZone: "America/Chicago" },
      search: search ?? null,
      count: rows.length,
      more: more ? `More than ${limit} events match; narrow the range or raise limit.` : undefined,
      events: rows,
    }

    return {
      forModel: forModelWithList(result, "events", rows),
      label: `Looked up events (${plural(rows.length, "event")}${search ? ` matching "${search}"` : ""}, ${range.from} to ${range.to})`,
      displays: rows.length
        ? [
            tableDisplay(shown, [
              { header: "Starts (CT)", value: (e) => ctShort(e.startsAtUtc) },
              { header: "Event", value: (e) => e.title },
              { header: "Status", value: (e) => getEffectiveEventStatus(e).toLowerCase().replace("_", " ") },
              { header: "Registered", value: (e) => counts.get(e.id)?.REGISTERED ?? 0 },
              { header: "Waitlist", value: (e) => counts.get(e.id)?.WAITLISTED ?? 0 },
              { header: "Attended", value: (e) => rows.find((r) => r.id === e.id)?.attendance.attended ?? null },
            ]),
          ]
        : [{ kind: "note", text: `No events${search ? ` matching "${search}"` : ""} between ${range.from} and ${range.to}.` }],
    }
  },
}
