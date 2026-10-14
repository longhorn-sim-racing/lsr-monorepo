import { beforeEach, describe, expect, it, vi } from "vitest"

// Stand-ins for the Prisma calls draft_event makes, the audit log and Next's revalidation
const db = vi.hoisted(() => ({
  venue: { findMany: vi.fn() },
  eventSeries: { findMany: vi.fn() },
  event: { findMany: vi.fn(), create: vi.fn() },
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("next/cache", () => cache)

import { draftEventInput, draftEventTool, pickOne, slugFrom, uniqueSlug, type DraftEventInput } from "./draft-event"

const ctx = { roomId: "room-1", actor: { userId: "officer-1", displayName: "Alex Officer" } }

const input = (overrides: Partial<DraftEventInput> = {}): DraftEventInput => ({
  title: "General Meeting 2",
  startsAt: "2026-11-02T18:00",
  endsAt: "2026-11-02T20:00",
  takeRegistrations: false,
  ...overrides,
})

beforeEach(() => {
  db.venue.findMany.mockResolvedValue([
    { id: "v1", name: "GDC 2.216" },
    { id: "v2", name: "Union Ballroom" },
    { id: "v3", name: "Union Theater" },
  ])
  db.eventSeries.findMany.mockResolvedValue([{ id: "s1", title: "General Meetings", slug: "general-meetings" }])
  db.event.findMany.mockResolvedValue([])
  db.event.create.mockImplementation(async ({ data }) => ({ id: "event-1", ...data }))
})

describe("draft_event", () => {
  it("creates a DRAFT through the event form's validation, in Central time", async () => {
    const result = await draftEventTool.run(input({ venue: "gdc", series: "general-meetings", summary: "Plans for the season", takeRegistrations: true, capacity: 40 }), ctx)
    expect(result.isError).toBeUndefined()

    const { data } = db.event.create.mock.calls[0][0]
    expect(data).toMatchObject({
      title: "General Meeting 2",
      slug: "general-meeting-2",
      status: "DRAFT",
      publishedAt: null,
      visibility: "public",
      timezone: "America/Chicago",
      venueId: "v1",
      seriesId: "s1",
      summary: "Plans for the season",
      registrationEnabled: true,
      registrationMax: 40,
      registrationFeeCents: null,
      attendanceReportingMode: "ASSUME_REGISTERED",
    })
    // Nov 2, 2026 is after daylight saving ends: 6 PM CST = midnight UTC
    expect(data.startsAtUtc.toISOString()).toBe("2026-11-03T00:00:00.000Z")
    expect(data.endsAtUtc.toISOString()).toBe("2026-11-03T02:00:00.000Z")
  })

  it("credits the officer who asked in the audit log, and revalidates the admin pages", async () => {
    await draftEventTool.run(input(), ctx)
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "officer-1",
        actionType: "CREATE",
        entityType: "EVENT",
        entityId: "event-1",
        summary: "Jack drafted event: General Meeting 2 (credited to Alex Officer, whose message started this reply)",
        metadata: { via: "jack", roomId: "room-1", status: "DRAFT" },
      }),
    )
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/events")
  })

  it("returns an event_draft display with the edit link, and never publishes", async () => {
    const result = await draftEventTool.run(input(), ctx)
    expect(result.label).toBe("Drafted General Meeting 2")
    expect(result.displays).toEqual([
      {
        kind: "event_draft",
        eventId: "event-1",
        title: "General Meeting 2",
        startsAt: "2026-11-03T00:00:00.000Z",
        endsAt: "2026-11-03T02:00:00.000Z",
        venue: null,
        editUrl: "/admin/events/event-1/edit",
      },
    ])
    const body = JSON.parse(result.forModel)
    // The model gets the whole link, so it never makes up the site's address; the room's card keeps the path
    expect(body).toMatchObject({ status: "DRAFT", startsAt: "Mon 2026-11-02 18:00 CT" })
    expect(body.link).toMatch(/^https?:\/\/[^/]+\/admin\/events\/event-1\/edit$/)
    expect(body.note).toContain("give this link exactly as it is")
    expect(draftEventTool.writes).toBe(true)
  })

  it("picks a free slug when the title's is taken", async () => {
    db.event.findMany.mockResolvedValue([{ slug: "general-meeting-2" }, { slug: "general-meeting-2-2" }])
    await draftEventTool.run(input(), ctx)
    expect(db.event.create.mock.calls[0][0].data.slug).toBe("general-meeting-2-3")
  })

  it("rejects an end before (or at) the start without writing", async () => {
    const result = await draftEventTool.run(input({ endsAt: "2026-11-02T17:00" }), ctx)
    expect(result).toMatchObject({ isError: true, label: "Couldn't draft the event" })
    expect(result.forModel).toContain("end after it starts")
    expect(db.event.create).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("rejects a date that doesn't exist with the form's message", async () => {
    const result = await draftEventTool.run(input({ startsAt: "2026-02-30T18:00", endsAt: "2026-02-30T20:00" }), ctx)
    expect(result.isError).toBe(true)
    expect(result.forModel).toContain("isn't a valid date")
    expect(db.event.create).not.toHaveBeenCalled()
  })

  it("asks which venue when the name is unclear, and lists them when nothing matches", async () => {
    const ambiguous = await draftEventTool.run(input({ venue: "union" }), ctx)
    expect(ambiguous.forModel).toBe('"union" matches more than one venue: Union Ballroom; Union Theater. Say which.')
    const missing = await draftEventTool.run(input({ venue: "Nowhere Hall" }), ctx)
    expect(missing.forModel).toContain("Existing: GDC 2.216; Union Ballroom; Union Theater.")
    expect(db.event.create).not.toHaveBeenCalled()
  })
})

describe("draft_event input", () => {
  it("requires both times as Central local time", () => {
    expect(draftEventInput.safeParse(input()).success).toBe(true)
    expect(draftEventInput.safeParse({ title: "x", startsAt: "2026-11-02T18:00" }).success).toBe(false)
    expect(draftEventInput.safeParse(input({ startsAt: "Nov 2 at 6pm" })).success).toBe(false)
    expect(draftEventInput.safeParse(input({ startsAt: "2026-11-02T18:00:00Z" })).success).toBe(false)
    expect(draftEventInput.safeParse(input({ title: "  " })).success).toBe(false)
    expect(draftEventInput.safeParse(input({ capacity: 0 })).success).toBe(false)
  })
})

describe("helpers", () => {
  it("slugs titles like the event form", () => {
    expect(slugFrom("GM #1: Kickoff!")).toBe("gm-1-kickoff")
    expect(uniqueSlug("gm", [])).toBe("gm")
    expect(uniqueSlug("gm", ["gm", "gm-2"])).toBe("gm-3")
  })

  it("finds by id, slug or exact name before a partial match", () => {
    const items = [
      { id: "a", name: "Union", slug: "u" },
      { id: "b", name: "Union Theater" },
    ]
    expect(pickOne(items, "union", "venue")).toEqual({ ok: true, item: items[0] })
    expect(pickOne(items, "b", "venue")).toEqual({ ok: true, item: items[1] })
    expect(pickOne(items, "U", "venue")).toEqual({ ok: true, item: items[0] })
    expect(pickOne(items, "theater", "venue")).toEqual({ ok: true, item: items[1] })
  })
})
