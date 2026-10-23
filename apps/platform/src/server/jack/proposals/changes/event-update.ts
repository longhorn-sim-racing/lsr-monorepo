import type { EventStatus, Prisma } from "@prisma/client"
import { z } from "zod"
import { DEFAULT_TIMEZONE, dateToZonedValue } from "@/lib/dates"
import { isEventPublic } from "@/lib/events"
import { centsToDollarInput } from "@/lib/money"
import { parseEventForm } from "@/schemas/event.schema"
import { prisma } from "@/server/db"
import { pickOne } from "@/server/jack/tools/draft-event"
import * as events from "@/server/services/event.service"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalDiffRow, ProposalKind, ProposalLink } from "../types"
import { fromLocal, LOCAL_TIME, listed, plural, revalidate, safeLink, when } from "./shared"

/**
 * event.update (design §4.3): changes to an existing event's details, registration, check-in or status,
 * saved through the same event service as the admin pages (src/server/services/event.service.ts):
 * the event form's fields through updateEventDetails, the registration card's through
 * updateEventRegistration, the check-in card's through updateEventAttendance, and the status override
 * through updateEventStatus. Each writes its own audit entry, linked to the proposal.
 *
 * The event as it would be after the change must pass the event form's own checks (parseEventForm:
 * start before end, registration and check-in windows that close after they open, capacity, the
 * Stripe minimum on a paid event's fee), checked when proposed and again before applying. The fee,
 * the event's link (slug), photo and visibility aren't changed by proposal: Jack never changes prices,
 * and the rest stay with the event's page.
 *
 * `before` holds the touched columns as they were (staleness: it's stale when any of them changed) and
 * the new values the card showed, which is exactly what applying writes.
 */

const STATUSES = ["PUBLISHED", "SCHEDULED", "DRAFT", "CANCELLED", "POSTPONED", "COMPLETED"] as const
type ProposedStatus = (typeof STATUSES)[number]
/** Set through the event form's publish buttons; the others through the status override */
const PUBLISHING: ProposedStatus[] = ["PUBLISHED", "SCHEDULED", "DRAFT"]

const local = z.string().trim().regex(LOCAL_TIME, "Use local time like 2026-10-19T18:00")

export const eventUpdateSchema = z
  .object({
    eventId: z.string().trim().min(1).max(64).describe("The event's id (Event.id), from events_overview or run_sql"),
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(500).optional().describe("Empty removes it"),
    description: z.string().trim().max(10_000).optional().describe("Empty removes it"),
    startsAt: local.optional().describe("Local time in the event's time zone, e.g. 2026-10-19T18:00"),
    endsAt: local.optional(),
    venue: z.string().trim().min(1).max(120).nullable().optional().describe("A venue's name or id; null removes it"),
    series: z.string().trim().min(1).max(120).nullable().optional().describe("A series' title, slug or id; null removes it"),
    streamUrl: z.string().trim().min(1).max(500).nullable().optional().describe("An https link; null removes it"),
    registrationEnabled: z.boolean().optional(),
    registrationOpensAt: local.nullable().optional().describe("null: open right away"),
    registrationClosesAt: local.nullable().optional().describe("null: stays open"),
    capacity: z.number().int().min(1).max(10_000).nullable().optional().describe("null: no limit"),
    waitlistEnabled: z.boolean().optional(),
    waitlistAutoPromote: z.boolean().optional().describe("Free events: move people off the waitlist on their own"),
    checkInEnabled: z.boolean().optional(),
    checkInOpensAt: local.nullable().optional(),
    checkInClosesAt: local.nullable().optional(),
    status: z.enum(STATUSES).optional().describe("PUBLISHED now, SCHEDULED at publishAt, DRAFT hides it; the others mark it on the site"),
    publishAt: local.optional().describe("With SCHEDULED"),
  })
  .refine((p) => Object.entries(p).some(([key, value]) => key !== "eventId" && value !== undefined), { message: "Give at least one change." })
  .refine((p) => (p.status === "SCHEDULED") === (p.publishAt !== undefined), { message: "status SCHEDULED needs publishAt, and publishAt goes only with SCHEDULED.", path: ["publishAt"] })

export type EventUpdate = z.infer<typeof eventUpdateSchema>

const EVENT_SELECT = {
  id: true,
  title: true,
  slug: true,
  timezone: true,
  summary: true,
  description: true,
  heroImageUrl: true,
  startsAtUtc: true,
  endsAtUtc: true,
  venueId: true,
  seriesId: true,
  streamUrl: true,
  status: true,
  publishedAt: true,
  visibility: true,
  registrationEnabled: true,
  registrationOpensAt: true,
  registrationClosesAt: true,
  registrationMax: true,
  registrationWaitlistEnabled: true,
  waitlistAutoPromote: true,
  registrationFeeCents: true,
  attendanceEnabled: true,
  attendanceOpensAt: true,
  attendanceClosesAt: true,
  venue: { select: { name: true } },
  series: { select: { title: true } },
} satisfies Prisma.EventSelect

export type EventRow = Prisma.EventGetPayload<{ select: typeof EVENT_SELECT }>

/** The Event columns this kind changes */
const COLUMNS = [
  "title",
  "summary",
  "description",
  "startsAtUtc",
  "endsAtUtc",
  "venueId",
  "seriesId",
  "streamUrl",
  "registrationEnabled",
  "registrationOpensAt",
  "registrationClosesAt",
  "registrationMax",
  "registrationWaitlistEnabled",
  "waitlistAutoPromote",
  "attendanceEnabled",
  "attendanceOpensAt",
  "attendanceClosesAt",
  "status",
  "publishedAt",
] as const
type Column = (typeof COLUMNS)[number]
/** As saved in `before`: dates as ISO strings */
type Value = string | number | boolean | null
type Values = Partial<Record<Column, Value>>

const TIME_COLUMNS: Column[] = ["startsAtUtc", "endsAtUtc", "registrationOpensAt", "registrationClosesAt", "attendanceOpensAt", "attendanceClosesAt", "publishedAt"]

/** Which admin save each column goes through */
const GROUP: Record<Column, "details" | "registration" | "checkin" | "status"> = {
  title: "details",
  summary: "details",
  description: "details",
  startsAtUtc: "details",
  endsAtUtc: "details",
  venueId: "details",
  seriesId: "details",
  streamUrl: "details",
  registrationEnabled: "registration",
  registrationOpensAt: "registration",
  registrationClosesAt: "registration",
  registrationMax: "registration",
  registrationWaitlistEnabled: "registration",
  waitlistAutoPromote: "registration",
  attendanceEnabled: "checkin",
  attendanceOpensAt: "checkin",
  attendanceClosesAt: "checkin",
  status: "status",
  publishedAt: "status",
}

const LABEL: Record<Column, string> = {
  title: "Title",
  summary: "Summary",
  description: "Description",
  startsAtUtc: "Starts",
  endsAtUtc: "Ends",
  venueId: "Venue",
  seriesId: "Series",
  streamUrl: "Stream link",
  registrationEnabled: "Registration",
  registrationOpensAt: "Registration opens",
  registrationClosesAt: "Registration closes",
  registrationMax: "Capacity",
  registrationWaitlistEnabled: "Waitlist",
  waitlistAutoPromote: "Waitlist moves up on its own",
  attendanceEnabled: "Check-in",
  attendanceOpensAt: "Check-in opens",
  attendanceClosesAt: "Check-in closes",
  status: "Status",
  publishedAt: "Goes live",
}

/** What a sentence calls each column: "Change “GM 2”: start time and capacity" */
const NOUN: Record<Column, string> = {
  title: "title",
  summary: "summary",
  description: "description",
  startsAtUtc: "start time",
  endsAtUtc: "end time",
  venueId: "venue",
  seriesId: "series",
  streamUrl: "stream link",
  registrationEnabled: "registration",
  registrationOpensAt: "registration opening",
  registrationClosesAt: "registration closing",
  registrationMax: "capacity",
  registrationWaitlistEnabled: "waitlist",
  waitlistAutoPromote: "waitlist moving up on its own",
  attendanceEnabled: "check-in",
  attendanceOpensAt: "check-in opening",
  attendanceClosesAt: "check-in closing",
  status: "status",
  publishedAt: "publish time",
}

/** The payload field for each column, for the model's error messages */
const FIELD: Partial<Record<Column, keyof EventUpdate>> = {
  startsAtUtc: "startsAt",
  endsAtUtc: "endsAt",
  registrationOpensAt: "registrationOpensAt",
  registrationClosesAt: "registrationClosesAt",
  attendanceOpensAt: "checkInOpensAt",
  attendanceClosesAt: "checkInClosesAt",
  publishedAt: "publishAt",
}

const STATUS_LABEL: Record<EventStatus, string> = {
  DRAFT: "Draft (hidden)",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  POSTPONED: "Postponed",
}

/** What `prepare` saves: the touched columns as they were, and as applying writes them */
const savedBefore = z.object({
  current: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  next: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** status PUBLISHED: the publish time is when it's applied */
  publishNow: z.boolean().optional(),
})
type SavedBefore = { current: Values; next: Values; publishNow?: boolean }

function parseBefore(value: unknown): SavedBefore | null {
  const parsed = savedBefore.safeParse(value)
  if (!parsed.success) return null
  const known = (record: Record<string, Value>) => Object.fromEntries(Object.entries(record).filter(([key]) => (COLUMNS as readonly string[]).includes(key))) as Values
  return { current: known(parsed.data.current), next: known(parsed.data.next), ...(parsed.data.publishNow ? { publishNow: true } : {}) }
}

export async function loadEvent(eventId: string): Promise<EventRow | null> {
  return prisma.event.findUnique({ where: { id: eventId }, select: EVENT_SELECT })
}

function json(value: unknown): Value {
  if (value instanceof Date) return value.toISOString()
  if (value === undefined) return null
  return value as Value
}

/** A column's value as the event has it, or as it's saved in `before` (dates back to Date) */
function columnValue(event: EventRow, column: Column): Value {
  const value = json(event[column])
  // The admin form saves an empty summary or description as ""; it reads the same as none
  return (column === "summary" || column === "description") && value === "" ? null : value
}

function asDate(value: Value | undefined): Date | null {
  return typeof value === "string" ? new Date(value) : null
}

/** The event with the proposed values in place, as the form's checks see it */
type Merged = Omit<EventRow, "venue" | "series">

function merge(event: EventRow, next: Values): Merged {
  const merged: Record<string, unknown> = { ...event }
  for (const [column, value] of Object.entries(next) as [Column, Value][]) merged[column] = TIME_COLUMNS.includes(column) ? asDate(value) : value
  return merged as Merged
}

/** The admin event form's fields for the merged event, so parseEventForm checks it exactly as it checks the form */
function eventForm(event: Merged): FormData {
  const zone = event.timezone || DEFAULT_TIMEZONE
  const form = new FormData()
  const fields: Record<string, string> = {
    title: event.title,
    slug: event.slug,
    timezone: zone,
    seriesId: event.seriesId ?? "",
    venueId: event.venueId ?? "",
    startsAtUtc: dateToZonedValue(event.startsAtUtc, zone),
    endsAtUtc: dateToZonedValue(event.endsAtUtc, zone),
    summary: event.summary ?? "",
    description: event.description ?? "",
    heroImageUrl: event.heroImageUrl ?? "",
    streamUrl: event.streamUrl ?? "",
    registrationOpensAt: dateToZonedValue(event.registrationOpensAt, zone),
    registrationClosesAt: dateToZonedValue(event.registrationClosesAt, zone),
    registrationMax: event.registrationMax ? String(event.registrationMax) : "",
    registrationFeeCents: centsToDollarInput(event.registrationFeeCents || null),
    attendanceOpensAt: dateToZonedValue(event.attendanceOpensAt, zone),
    attendanceClosesAt: dateToZonedValue(event.attendanceClosesAt, zone),
  }
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  if (event.registrationEnabled) form.set("registrationEnabled", "on")
  if (event.registrationWaitlistEnabled) form.set("registrationWaitlistEnabled", "on")
  if (event.attendanceEnabled) form.set("attendanceEnabled", "on")
  return form
}

/** Why the event with these changes wouldn't pass the admin pages' checks, or null when it would */
export function eventProblem(event: EventRow, next: Values, now = new Date()): string | null {
  const merged = merge(event, next)
  const parsed = parseEventForm(eventForm(merged))
  if (!parsed.ok) return parsed.error
  if (next.waitlistAutoPromote === true && (merged.registrationFeeCents ?? 0) > 0) {
    return "It has a fee, and paid events move people off the waitlist by hand (they haven't paid yet), so moving them up on their own can't be switched on."
  }
  if (next.status === "SCHEDULED" && merged.publishedAt && merged.publishedAt <= now) return `The publish time (${when(merged.publishedAt, merged.timezone || DEFAULT_TIMEZONE)}) has passed. Publish it now instead.`
  return null
}

type Refs = { venue?: { id: string; name: string } | null; series?: { id: string; name: string } | null }

async function resolveRefs(p: EventUpdate): Promise<Refs> {
  const refs: Refs = {}
  if (p.venue === null) refs.venue = null
  else if (p.venue !== undefined) {
    const venues = await prisma.venue.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })
    const found = pickOne(venues, p.venue, "venue")
    if (!found.ok) throw new ProposalInputError(found.error.replace(" Leave it out to add it later in the form.", ""))
    refs.venue = found.item
  }
  if (p.series === null) refs.series = null
  else if (p.series !== undefined) {
    const series = await prisma.eventSeries.findMany({ select: { id: true, title: true, slug: true }, orderBy: { title: "asc" } })
    const found = pickOne(
      series.map((s) => ({ id: s.id, name: s.title, slug: s.slug })),
      p.series,
      "event series",
    )
    if (!found.ok) throw new ProposalInputError(found.error.replace(" Leave it out to add it later in the form.", ""))
    refs.series = { id: found.item.id, name: found.item.name }
  }
  return refs
}

/** The proposed values for the columns that would change. Throws ProposalInputError for times that aren't real */
export function plan(p: EventUpdate, event: EventRow, refs: Refs): { next: Values; publishNow: boolean } {
  const zone = event.timezone || DEFAULT_TIMEZONE
  const wanted: Values = {}
  const time = (column: Column, value: string | null | undefined) => {
    if (value === undefined) return
    if (value === null) {
      wanted[column] = null
      return
    }
    const date = fromLocal(value, zone)
    if (!date) throw new ProposalInputError(`${FIELD[column]}: ${value} isn't a time on the calendar in ${zone}.`)
    wanted[column] = date.toISOString()
  }

  if (p.title !== undefined) wanted.title = p.title
  if (p.summary !== undefined) wanted.summary = p.summary || null
  if (p.description !== undefined) wanted.description = p.description || null
  time("startsAtUtc", p.startsAt)
  time("endsAtUtc", p.endsAt)
  if (refs.venue !== undefined) wanted.venueId = refs.venue?.id ?? null
  if (refs.series !== undefined) wanted.seriesId = refs.series?.id ?? null
  if (p.streamUrl !== undefined) {
    if (p.streamUrl === null) wanted.streamUrl = null
    else {
      const link = safeLink(p.streamUrl)
      if (!link?.host) throw new ProposalInputError(`streamUrl: ${p.streamUrl} isn't an https link.`)
      wanted.streamUrl = link.url
    }
  }
  if (p.registrationEnabled !== undefined) wanted.registrationEnabled = p.registrationEnabled
  time("registrationOpensAt", p.registrationOpensAt)
  time("registrationClosesAt", p.registrationClosesAt)
  if (p.capacity !== undefined) wanted.registrationMax = p.capacity
  if (p.waitlistEnabled !== undefined) wanted.registrationWaitlistEnabled = p.waitlistEnabled
  if (p.waitlistAutoPromote !== undefined) wanted.waitlistAutoPromote = p.waitlistAutoPromote
  if (p.checkInEnabled !== undefined) wanted.attendanceEnabled = p.checkInEnabled
  time("attendanceOpensAt", p.checkInOpensAt)
  time("attendanceClosesAt", p.checkInClosesAt)

  let publishNow = false
  if (p.status === "SCHEDULED") {
    wanted.status = "SCHEDULED"
    time("publishedAt", p.publishAt)
  } else if (p.status === "PUBLISHED") {
    wanted.status = "PUBLISHED"
    // Publishing a scheduled event early, or a draft, sets its publish time to the moment it's applied
    publishNow = event.status !== "PUBLISHED"
  } else if (p.status) {
    wanted.status = p.status
  }

  const next: Values = {}
  for (const [column, value] of Object.entries(wanted) as [Column, Value][]) {
    if (column === "publishedAt" && wanted.status !== "SCHEDULED") continue
    if (columnValue(event, column) !== value) next[column] = value
  }
  // A status that doesn't change isn't a change, but a new publish time for a scheduled event is; and
  // scheduling always carries its publish time, even one the event already has
  if (wanted.status === "SCHEDULED" && (next.status !== undefined || next.publishedAt !== undefined)) {
    next.status = "SCHEDULED"
    next.publishedAt = wanted.publishedAt ?? null
  }
  return { next, publishNow: publishNow && next.status === "PUBLISHED" }
}

function onOff(value: Value): string {
  return value ? "On" : "Off"
}

/** A column's value as the card shows it */
function display(column: Column, value: Value | undefined, event: EventRow, names: { venue?: string | null; series?: string | null }): string | null {
  const zone = event.timezone || DEFAULT_TIMEZONE
  if (value === undefined) return null
  switch (column) {
    case "startsAtUtc":
    case "endsAtUtc":
    case "publishedAt":
      return value === null ? null : when(new Date(String(value)), zone)
    case "registrationOpensAt":
      return value === null ? "Right away" : when(new Date(String(value)), zone)
    case "registrationClosesAt":
      return value === null ? "Stays open" : when(new Date(String(value)), zone)
    case "attendanceOpensAt":
    case "attendanceClosesAt":
      return value === null ? "No limit" : when(new Date(String(value)), zone)
    case "registrationMax":
      return value === null ? "No limit" : Number(value).toLocaleString("en-US")
    case "registrationEnabled":
    case "registrationWaitlistEnabled":
    case "waitlistAutoPromote":
    case "attendanceEnabled":
      return onOff(value)
    case "venueId":
      return value === null ? null : (names.venue ?? (value === event.venueId ? (event.venue?.name ?? null) : null))
    case "seriesId":
      return value === null ? null : (names.series ?? (value === event.seriesId ? (event.series?.title ?? null) : null))
    case "status":
      return STATUS_LABEL[value as EventStatus] ?? String(value)
    default:
      return value === null ? null : String(value)
  }
}

/** People off the waitlist when this is applied, as the registration service's reconcile works it out */
export function expectedPromotions(event: Merged, before: EventRow, next: Values, counts: { registered: number; waitlisted: number }): number {
  if (!counts.waitlisted || (event.registrationFeeCents ?? 0) > 0) return 0
  const capacityRaised = next.registrationMax !== undefined && before.registrationMax !== null && (event.registrationMax === null || event.registrationMax > before.registrationMax)
  const autoSwitchedOn = next.waitlistAutoPromote === true && !before.waitlistAutoPromote
  if (!capacityRaised && !autoSwitchedOn) return 0
  if (event.registrationMax === null) return counts.waitlisted
  if (!event.waitlistAutoPromote) return 0
  return Math.min(counts.waitlisted, Math.max(0, event.registrationMax - counts.registered))
}

async function registrationCounts(eventId: string): Promise<{ registered: number; waitlisted: number }> {
  const groups = await prisma.eventRegistration.groupBy({ by: ["status"], where: { eventId }, _count: { _all: true } })
  const count = (status: string) => groups.find((g) => g.status === status)?._count._all ?? 0
  return { registered: count("REGISTERED"), waitlisted: count("WAITLISTED") }
}

function eventLinks(event: { id: string; slug: string }, publicPage: boolean): ProposalLink[] {
  return [
    { title: "Edit event", url: `/admin/events/${event.id}/edit` },
    { title: "Registration and check-in", url: `/admin/events/${event.id}/manage` },
    ...(publicPage ? [{ title: "Event page", url: `/events/${event.slug}` }] : []),
  ]
}

const STATUS_TITLE: Record<ProposedStatus, string> = {
  PUBLISHED: "Publish",
  SCHEDULED: "Schedule",
  DRAFT: "Move back to draft:",
  CANCELLED: "Cancel",
  POSTPONED: "Postpone",
  COMPLETED: "Mark completed:",
}

function proposalTitle(event: EventRow, next: Values): string {
  const name = `“${event.title}”`
  const changed = (Object.keys(next) as Column[]).filter((column) => column !== "status" && column !== "publishedAt")
  const status = next.status as ProposedStatus | undefined
  if (!changed.length && status) return `${STATUS_TITLE[status]} ${name}`
  const what = changed.slice(0, 3).map((column) => NOUN[column])
  const rest = changed.length > 3 ? `${what.join(", ")} and ${changed.length - 3} more` : listed(what)
  const and = status === "PUBLISHED" ? " and publish it" : status === "SCHEDULED" ? " and schedule it" : status ? ` and set it to ${STATUS_LABEL[status].toLowerCase()}` : ""
  return `Change ${name}: ${rest}${and}`
}

function consequences(event: EventRow, merged: Merged, next: Values, counts: { registered: number; waitlisted: number }, now: Date): string[] {
  const zone = event.timezone || DEFAULT_TIMEZONE
  const lines: string[] = []
  const status = next.status as ProposedStatus | undefined
  if (status === "PUBLISHED") lines.push(event.visibility === "public" ? `It goes live on the site at /events/${event.slug}.` : `Its visibility is ${event.visibility}, so it still won't show to the public.`)
  if (status === "SCHEDULED" && merged.publishedAt) lines.push(`It goes live on the site ${when(merged.publishedAt, zone)}.`)
  if (status === "DRAFT") lines.push("It's hidden from the site until it's published again.")
  if (status === "CANCELLED" || status === "POSTPONED") lines.push(`It stays on the site, marked ${status.toLowerCase()}. Registered members aren't messaged about it automatically.`)
  if (status === "COMPLETED") lines.push("It shows on the site as over.")
  if ((next.startsAtUtc !== undefined || next.endsAtUtc !== undefined) && counts.registered) {
    lines.push(`${plural(counts.registered, "person is", "people are")} registered; they aren't messaged about the new time automatically.`)
  }
  const promoted = expectedPromotions(merged, event, next, counts)
  if (promoted) lines.push(`It moves ${plural(promoted, "person", "people")} off the waitlist into the event, and they're notified.`)
  if (next.registrationMax !== undefined && merged.registrationMax !== null && counts.registered > merged.registrationMax) {
    lines.push(`${plural(counts.registered, "person is", "people are")} already registered, more than the new capacity; nobody is removed.`)
  }
  if (next.registrationEnabled === false && counts.registered) lines.push(`Registration closes on the event page; the ${plural(counts.registered, "person", "people")} already registered stay registered.`)
  if (merged.startsAtUtc < now && (next.startsAtUtc !== undefined || status === "PUBLISHED")) lines.push("Heads up: it starts in the past.")
  return lines
}

export const eventUpdateKind: ProposalKind<EventUpdate> = {
  kind: "event.update",
  tool: "propose_change",
  description:
    "event.update: change an existing event: its title, summary, description, start or end time, venue, series or stream link; its registration (on or off, when it opens and closes, capacity, waitlist); its check-in; or its status (publish now, schedule, back to draft, cancel, postpone, completed). Get the event's id from events_overview. Times are local in the event's time zone (Central unless it says otherwise), like 2026-10-19T18:00. Give only what changes, and put every change to one event in one proposal (a newer one replaces it). It can't change an event's fee, link, photo or visibility; those stay on the event's page.",
  schema: eventUpdateSchema,
  targetType: "EVENT",
  permission: "officer",

  async prepare(p) {
    const event = await loadEvent(p.eventId)
    if (!event) throw new ProposalInputError(`There's no event with id ${p.eventId}. Find it with events_overview.`)
    const refs = await resolveRefs(p)
    const { next, publishNow } = plan(p, event, refs)
    if (!Object.keys(next).length) throw new ProposalInputError(`Nothing would change: “${event.title}” already has these values.`)
    const now = new Date()
    const problem = eventProblem(event, next, now)
    if (problem) throw new ProposalInputError(`With this change the event wouldn't pass the event form's checks: ${problem}`)

    const columns = Object.keys(next) as Column[]
    const current: Values = Object.fromEntries(columns.map((column) => [column, columnValue(event, column)]))
    // The publish time goes with the status: a status change is stale if either moved
    if (next.status !== undefined && current.publishedAt === undefined) current.publishedAt = columnValue(event, "publishedAt")
    const counts = await registrationCounts(event.id)
    const merged = merge(event, next)
    const names = { venue: refs.venue?.name, series: refs.series?.name }

    const diff: ProposalDiffRow[] = columns.map((column) => ({
      field: column,
      label: LABEL[column],
      before: column === "status" && event.status === "SCHEDULED" && event.publishedAt ? `Scheduled for ${when(event.publishedAt, event.timezone || DEFAULT_TIMEZONE)}` : display(column, columnValue(event, column), event, {}),
      after: column === "status" && publishNow ? "Published (now)" : display(column, next[column], event, names),
      format: column === "description" ? "markdown" : column === "title" || column === "summary" || column === "streamUrl" ? "text" : "value",
    }))
    const publicAfter = isEventPublic({ status: merged.status, publishedAt: publishNow ? now : merged.publishedAt, visibility: event.visibility }, now)
    const statusOnly = columns.every((column) => GROUP[column] === "status")
    const summary = [...(statusOnly ? [] : ["Applying it saves the changes below."]), ...consequences(event, merged, next, counts, now)].join(" ") || "Applying it saves the change below."
    return {
      before: { current, next, ...(publishNow ? { publishNow: true } : {}) } satisfies SavedBefore,
      targetId: event.id,
      view: { title: proposalTitle(event, next), summary, diff, links: eventLinks(event, publicAfter || isEventPublic(event, now)) },
    }
  },

  async checkStale(p, before) {
    const saved = parseBefore(before)
    if (!saved) return "The proposal's copy of the event is missing. Ask Jack to propose it again."
    const event = await loadEvent(p.eventId)
    if (!event) return "The event was deleted."
    for (const [column, was] of Object.entries(saved.current) as [Column, Value][]) {
      const now = columnValue(event, column)
      if (now !== was) return `The event's ${NOUN[column]} changed since this was proposed (it's now ${display(column, now, event, {}) ?? "not set"}).`
    }
    const problem = eventProblem(event, saved.next)
    return problem ? `With this change the event no longer passes the event form's checks: ${problem}` : null
  },

  async apply(p, ctx) {
    const saved = parseBefore(ctx.before)
    if (!saved) throw new StaleProposalError("The proposal's copy of the event is missing. Ask Jack to propose it again.")
    const event = await loadEvent(p.eventId)
    if (!event) throw new StaleProposalError("The event was deleted.")
    const { next } = saved
    const actor = { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata }
    const columns = (group: (typeof GROUP)[Column]) => (Object.keys(next) as Column[]).filter((column) => GROUP[column] === group)
    const values = (group: (typeof GROUP)[Column]) => Object.fromEntries(columns(group).map((column) => [column, TIME_COLUMNS.includes(column) ? asDate(next[column]) : next[column]])) as never

    const paths: string[] = []
    const done: string[] = []
    let promoted = 0
    const step = async (what: string, run: () => Promise<void>) => {
      try {
        await run()
        done.push(what)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(done.length ? `Saved the event's ${listed(done)}, then couldn't save its ${what}: ${message.replace(/[.\s]*$/, ".")} Check the event's page.` : message)
      }
    }

    const status = next.status as ProposedStatus | undefined
    const publish = status && PUBLISHING.includes(status) ? { status, publishedAt: status === "PUBLISHED" ? new Date() : status === "SCHEDULED" ? asDate(next.publishedAt) : null } : null
    if (columns("details").length || publish) {
      await step("details", async () => {
        const result = await events.updateEventDetails({ eventId: event.id, details: values("details"), publish }, actor)
        if (!result.ok) throw new Error(result.error)
        paths.push(...result.revalidate)
        promoted += result.promotedUserIds.length
      })
    }
    if (columns("registration").length) {
      await step("registration settings", async () => {
        const result = await events.updateEventRegistration({ eventId: event.id, settings: values("registration") }, actor)
        paths.push(...result.revalidate)
        promoted += result.promotedUserIds.length
      })
    }
    if (columns("checkin").length) {
      await step("check-in settings", async () => {
        const merged = merge(event, next)
        const result = await events.updateEventAttendance(
          { eventId: event.id, attendanceEnabled: merged.attendanceEnabled, attendanceOpensAt: merged.attendanceOpensAt, attendanceClosesAt: merged.attendanceClosesAt },
          actor,
        )
        paths.push(...result.revalidate)
      })
    }
    if (status && !PUBLISHING.includes(status)) {
      await step("status", async () => {
        const result = await events.updateEventStatus({ eventId: event.id, status }, actor)
        paths.push(...result.revalidate)
      })
    }
    revalidate(paths)

    const changed = (Object.keys(next) as Column[]).filter((column) => column !== "publishedAt").map((column) => NOUN[column])
    const after = await loadEvent(event.id)
    const title = after?.title ?? event.title
    return {
      summary: `Updated “${title}”: ${listed(changed)}.${promoted ? ` ${plural(promoted, "person", "people")} moved off the waitlist and were notified.` : ""}`,
      links: eventLinks({ id: event.id, slug: after?.slug ?? event.slug }, after ? isEventPublic(after) : false),
      ...(promoted ? { counts: { promoted } } : {}),
    }
  },
}
