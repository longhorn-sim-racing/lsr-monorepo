import { Prisma } from "@prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { parseEventForm } from "@/schemas/event.schema"
import { createAuditLog } from "@/server/audit/log"
import { prisma } from "@/server/db"
import { forModel } from "./display"
import { CLUB_TZ, ct } from "./time"
import type { JackTool, JackToolContext } from "./types"

/**
 * draft_event: the only tool that writes (#161). It creates an Event as a DRAFT through the same
 * validation as the admin event form (parseEventForm) and the same create as createEvent, credits
 * the officer who asked in the audit log, and links to the edit page. It never publishes: an
 * officer does that from the form. No fees either; money stays out of Jack's hands.
 */

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/** Same slug rule as the admin event form */
export function slugFrom(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/** The first free slug: base, base-2, base-3, … */
export function uniqueSlug(base: string, taken: string[]): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`
}

type Named = { id: string; name: string; slug?: string }

/** Finds one venue or series by id, slug or name: exact name first, then a unique partial match */
export function pickOne<T extends Named>(items: T[], query: string, what: string): { ok: true; item: T } | { ok: false; error: string } {
  const q = query.trim().toLowerCase()
  const exact = items.find((i) => i.id === query.trim() || i.slug?.toLowerCase() === q || i.name.toLowerCase() === q)
  if (exact) return { ok: true, item: exact }
  const partial = items.filter((i) => i.name.toLowerCase().includes(q))
  if (partial.length === 1) return { ok: true, item: partial[0] }
  const list = (partial.length ? partial : items).slice(0, 20).map((i) => i.name)
  return {
    ok: false,
    error: partial.length
      ? `"${query}" matches more than one ${what}: ${list.join("; ")}. Say which.`
      : `No ${what} matches "${query}". ${list.length ? `Existing: ${list.join("; ")}.` : `There are no ${what}s yet.`} Leave it out to add it later in the form.`,
  }
}

export const draftEventInput = z.object({
  title: z.string().trim().min(1).max(200).describe('The event title, e.g. "General Meeting 2"'),
  startsAt: z.string().trim().regex(LOCAL_TIME, "Use Central local time like 2026-10-19T18:00").describe("Start, Central local time: YYYY-MM-DDTHH:mm"),
  endsAt: z.string().trim().regex(LOCAL_TIME, "Use Central local time like 2026-10-19T20:00").describe("End, Central local time: YYYY-MM-DDTHH:mm"),
  venue: z.string().max(120).optional().describe("An existing venue's name or id"),
  series: z.string().max(120).optional().describe("An existing event series' title, slug or id"),
  summary: z.string().max(500).optional().describe("One or two sentences for the event card"),
  description: z.string().max(5_000).optional().describe("Longer details for the event page"),
  takeRegistrations: z.boolean().default(false).describe("Let members register on the event page"),
  capacity: z.number().int().min(1).max(10_000).optional().describe("Registration limit; leave out for no limit"),
})

export type DraftEventInput = z.infer<typeof draftEventInput>

/** The admin form's fields, filled from Jack's input, so parseEventForm validates it exactly as it does the form */
export function draftFormData(input: DraftEventInput, ids: { slug: string; venueId: string | null; seriesId: string | null }): FormData {
  const form = new FormData()
  const fields: Record<string, string> = {
    title: input.title,
    slug: ids.slug,
    timezone: CLUB_TZ,
    seriesId: ids.seriesId ?? "",
    venueId: ids.venueId ?? "",
    startsAtUtc: input.startsAt,
    endsAtUtc: input.endsAt,
    summary: input.summary ?? "",
    description: input.description ?? "",
    heroImageUrl: "",
    streamUrl: "",
    registrationOpensAt: "",
    registrationClosesAt: "",
    registrationMax: input.capacity ? String(input.capacity) : "",
    registrationFeeCents: "",
    attendanceOpensAt: "",
    attendanceClosesAt: "",
  }
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  if (input.takeRegistrations) form.set("registrationEnabled", "on")
  return form
}

const fail = (message: string) => ({ isError: true, forModel: message, label: "Couldn't draft the event", displays: [] })

function revalidateAdmin() {
  // Outside a Next request (scripts, tests) there's nothing to revalidate
  try {
    revalidatePath("/admin/events")
    revalidatePath("/admin")
  } catch {}
}

export async function draftEvent(input: DraftEventInput, ctx: JackToolContext) {
  if (input.endsAt <= input.startsAt) return fail(`The event has to end after it starts (start ${input.startsAt}, end ${input.endsAt}).`)

  const [venues, series] = await Promise.all([
    input.venue ? prisma.venue.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
    input.series ? prisma.eventSeries.findMany({ select: { id: true, title: true, slug: true }, orderBy: { title: "asc" } }) : Promise.resolve([]),
  ])
  let venue: Named | null = null
  if (input.venue) {
    const found = pickOne(venues, input.venue, "venue")
    if (!found.ok) return fail(found.error)
    venue = found.item
  }
  let seriesPick: Named | null = null
  if (input.series) {
    const found = pickOne(series.map((s) => ({ id: s.id, name: s.title, slug: s.slug })), input.series, "event series")
    if (!found.ok) return fail(found.error)
    seriesPick = found.item
  }

  const base = slugFrom(input.title) || "event"
  const taken = await prisma.event.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })
  let slug = uniqueSlug(
    base,
    taken.map((e) => e.slug),
  )

  const parsed = parseEventForm(draftFormData(input, { slug, venueId: venue?.id ?? null, seriesId: seriesPick?.id ?? null }))
  if (!parsed.ok) return fail(parsed.error)
  const fields = parsed.data

  let event
  for (let attempt = 0; ; attempt++) {
    try {
      event = await prisma.event.create({
        data: {
          ...fields,
          slug,
          status: "DRAFT",
          publishedAt: null,
          visibility: "public",
          attendanceReportingMode: fields.attendanceEnabled ? "CHECKIN_REQUIRED" : "ASSUME_REGISTERED",
        },
      })
      break
    } catch (error) {
      // Someone took the slug in the meantime
      if (attempt < 3 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        slug = `${base}-${Date.now().toString(36).slice(-4)}`
        continue
      }
      throw error
    }
  }

  await createAuditLog({
    actorUserId: ctx.actor.userId,
    actionType: "CREATE",
    entityType: "EVENT",
    entityId: event.id,
    summary: `Jack drafted event: ${event.title} (asked by ${ctx.actor.displayName})`,
    after: event,
    metadata: { via: "jack", roomId: ctx.roomId, status: "DRAFT" },
  })
  revalidateAdmin()

  const editUrl = `/admin/events/${event.id}/edit`
  const now = new Date()
  return {
    forModel: forModel({
      eventId: event.id,
      title: event.title,
      slug: event.slug,
      status: "DRAFT",
      startsAt: ct(event.startsAtUtc),
      endsAt: ct(event.endsAtUtc),
      venue: venue?.name ?? null,
      series: seriesPick?.name ?? null,
      takesRegistrations: event.registrationEnabled,
      capacity: event.registrationMax,
      editUrl,
      note: `Saved as a draft, hidden from members. An officer reviews and publishes it from ${editUrl}.${event.startsAtUtc < now ? " Heads up: it starts in the past." : ""}`,
    }),
    label: `Drafted ${event.title}`,
    displays: [
      {
        kind: "event_draft" as const,
        eventId: event.id,
        title: event.title,
        startsAt: event.startsAtUtc.toISOString(),
        endsAt: event.endsAtUtc.toISOString(),
        venue: venue?.name ?? null,
        editUrl,
      },
    ],
  }
}

export const draftEventTool: JackTool<DraftEventInput> = {
  name: "draft_event",
  description:
    "Create a new event as a DRAFT (hidden from members) for an officer to review and publish. Times are Central local time (YYYY-MM-DDTHH:mm). Venue and series must already exist (by name); leave them out if unsure. Free events only. It never publishes; reply with the edit link it returns. Check events_overview first so you don't draft a duplicate.",
  input: draftEventInput,
  writes: true,
  run: draftEvent,
}
