import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  event: { findUnique: vi.fn() },
  venue: { findMany: vi.fn() },
  eventSeries: { findMany: vi.fn() },
  eventRegistration: { groupBy: vi.fn() },
}))
const events = vi.hoisted(() => ({ updateEventDetails: vi.fn(), updateEventRegistration: vi.fn(), updateEventAttendance: vi.fn(), updateEventStatus: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePaths: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/event.service", () => events)
vi.mock("@/server/cache/revalidate-public", () => cache)

import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { eventUpdateKind, eventUpdateSchema, type EventUpdate } from "./event-update"

// GM 2: Thu Oct 29, 6 to 8 PM CT (CDT, UTC-5)
const GM2 = {
  id: "ev-1",
  title: "GM 2",
  slug: "gm-2",
  timezone: "America/Chicago",
  summary: "Second general meeting",
  description: null,
  heroImageUrl: null,
  startsAtUtc: new Date("2026-10-29T23:00:00Z"),
  endsAtUtc: new Date("2026-10-30T01:00:00Z"),
  venueId: "v1",
  seriesId: null,
  streamUrl: null,
  status: "PUBLISHED",
  publishedAt: new Date("2026-10-01T15:00:00Z"),
  visibility: "public",
  registrationEnabled: true,
  registrationOpensAt: null,
  registrationClosesAt: null,
  registrationMax: 20,
  registrationWaitlistEnabled: true,
  waitlistAutoPromote: true,
  registrationFeeCents: null,
  attendanceEnabled: false,
  attendanceOpensAt: null,
  attendanceClosesAt: null,
  venue: { name: "Alienware Lounge" },
  series: null,
}

const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const audit = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" }
const applyCtx = (before: unknown): ProposalApplyContext => ({ officer: { userId: "u2", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: audit })
const actor = { userId: "u2", auditMetadata: audit }

const parse = (p: Record<string, unknown>) => eventUpdateSchema.parse({ eventId: "ev-1", ...p }) as EventUpdate
const prepare = (p: Record<string, unknown>) => eventUpdateKind.prepare(parse(p), ctx)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-22T17:00:00Z"))
  db.event.findUnique.mockResolvedValue(GM2)
  db.venue.findMany.mockResolvedValue([
    { id: "v1", name: "Alienware Lounge" },
    { id: "v2", name: "Gates Dell Complex" },
  ])
  db.eventSeries.findMany.mockResolvedValue([])
  db.eventRegistration.groupBy.mockResolvedValue([
    { status: "REGISTERED", _count: { _all: 12 } },
    { status: "WAITLISTED", _count: { _all: 0 } },
  ])
  events.updateEventDetails.mockResolvedValue({ ok: true, event: { id: "ev-1", slug: "gm-2", seriesId: null, title: "GM 2" }, promotedUserIds: [], revalidate: ["/admin/events", "/events", "/events/gm-2"] })
  events.updateEventRegistration.mockResolvedValue({ ok: true, event: { id: "ev-1", slug: "gm-2" }, promotedUserIds: [], revalidate: ["/admin/events/ev-1/manage", "/events", "/events/gm-2"] })
  events.updateEventAttendance.mockResolvedValue({ ok: true, event: { id: "ev-1", slug: "gm-2", attendanceReportingMode: "CHECKIN_REQUIRED" }, revalidate: ["/admin/events/ev-1/manage"] })
  events.updateEventStatus.mockResolvedValue({ ok: true, event: { id: "ev-1", slug: "gm-2" }, revalidate: ["/admin/events", "/events", "/events/gm-2"] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("event.update's schema", () => {
  it("needs a change, and publishAt exactly with SCHEDULED", () => {
    expect(eventUpdateSchema.safeParse({ eventId: "ev-1" }).success).toBe(false)
    expect(eventUpdateSchema.safeParse({ eventId: "ev-1", title: "GM 2!" }).success).toBe(true)
    expect(eventUpdateSchema.safeParse({ eventId: "ev-1", status: "SCHEDULED" }).success).toBe(false)
    expect(eventUpdateSchema.safeParse({ eventId: "ev-1", publishAt: "2026-10-25T09:00" }).success).toBe(false)
    expect(eventUpdateSchema.safeParse({ eventId: "ev-1", status: "SCHEDULED", publishAt: "2026-10-25T09:00" }).success).toBe(true)
    expect(eventUpdateSchema.safeParse({ eventId: "ev-1", startsAt: "Oct 29 7pm" }).success).toBe(false)
    expect(eventUpdateKind).toMatchObject({ kind: "event.update", tool: "propose_change", permission: "officer", targetType: "EVENT" })
  })
})

describe("event.update: prepare", () => {
  it("describes a new start time in the event's zone, and says registrants aren't told", async () => {
    const prepared = await prepare({ startsAt: "2026-10-29T19:00" })
    expect(prepared.targetId).toBe("ev-1")
    expect(prepared.before).toEqual({ current: { startsAtUtc: "2026-10-29T23:00:00.000Z" }, next: { startsAtUtc: "2026-10-30T00:00:00.000Z" } })
    expect(prepared.view.title).toBe("Change “GM 2”: start time")
    expect(prepared.view.diff).toEqual([{ field: "startsAtUtc", label: "Starts", before: "Thu Oct 29, 6:00 PM CT", after: "Thu Oct 29, 7:00 PM CT", format: "value" }])
    expect(prepared.view.summary).toBe("Applying it saves the changes below. 12 people are registered; they aren't messaged about the new time automatically.")
    expect(prepared.view.links).toEqual([
      { title: "Edit event", url: "/admin/events/ev-1/edit" },
      { title: "Registration and check-in", url: "/admin/events/ev-1/manage" },
      { title: "Event page", url: "/events/gm-2" },
    ])
  })

  it("publishes a draft now, saying where it goes live", async () => {
    db.event.findUnique.mockResolvedValue({ ...GM2, status: "DRAFT", publishedAt: null })
    const prepared = await prepare({ status: "PUBLISHED" })
    expect(prepared.view.title).toBe("Publish “GM 2”")
    expect(prepared.view.diff).toEqual([{ field: "status", label: "Status", before: "Draft (hidden)", after: "Published (now)", format: "value" }])
    expect(prepared.view.summary).toBe("It goes live on the site at /events/gm-2.")
    expect(prepared.before).toEqual({ current: { status: "DRAFT", publishedAt: null }, next: { status: "PUBLISHED" }, publishNow: true })
  })

  it("schedules with the publish time, and refuses one that has passed", async () => {
    db.event.findUnique.mockResolvedValue({ ...GM2, status: "DRAFT", publishedAt: null })
    const prepared = await prepare({ status: "SCHEDULED", publishAt: "2026-10-25T09:00" })
    expect(prepared.before).toMatchObject({ next: { status: "SCHEDULED", publishedAt: "2026-10-25T14:00:00.000Z" } })
    expect(prepared.view.summary).toBe("It goes live on the site Sun Oct 25, 9:00 AM CT.")
    await expect(prepare({ status: "SCHEDULED", publishAt: "2026-10-20T09:00" })).rejects.toThrow(/The publish time \(Tue Oct 20, 9:00 AM CT\) has passed/)
  })

  it("names a venue by name, and offers the list when it doesn't know one", async () => {
    const prepared = await prepare({ venue: "gates dell complex" })
    expect(prepared.view.diff).toEqual([{ field: "venueId", label: "Venue", before: "Alienware Lounge", after: "Gates Dell Complex", format: "value" }])
    await expect(prepare({ venue: "Moon Base" })).rejects.toThrow('No venue matches "Moon Base". Existing: Alienware Lounge; Gates Dell Complex.')
  })

  it("says how many move off the waitlist when capacity goes up", async () => {
    db.eventRegistration.groupBy.mockResolvedValue([
      { status: "REGISTERED", _count: { _all: 20 } },
      { status: "WAITLISTED", _count: { _all: 5 } },
    ])
    const prepared = await prepare({ capacity: 23 })
    expect(prepared.view.summary).toContain("It moves 3 people off the waitlist into the event, and they're notified.")
    const lower = await prepare({ capacity: 15 })
    expect(lower.view.summary).toContain("20 people are already registered, more than the new capacity; nobody is removed.")
  })

  it("refuses what the event form refuses, and changes that change nothing", async () => {
    const refused = async (p: Record<string, unknown>) => {
      const error = await prepare(p).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ProposalInputError)
      return (error as Error).message
    }
    expect(await refused({ endsAt: "2026-10-29T17:00" })).toMatch(/wouldn't pass the event form's checks: The event can't end before it starts/)
    expect(await refused({ registrationOpensAt: "2026-10-28T12:00", registrationClosesAt: "2026-10-27T12:00" })).toMatch(/Registration must close after it opens/)
    expect(await refused({ startsAt: "2026-02-30T10:00" })).toBe("startsAt: 2026-02-30T10:00 isn't a time on the calendar in America/Chicago.")
    expect(await refused({ title: "GM 2", capacity: 20 })).toBe("Nothing would change: “GM 2” already has these values.")
    expect(await refused({ streamUrl: "javascript:alert(1)" })).toMatch(/isn't an https link/)
    db.event.findUnique.mockResolvedValue({ ...GM2, registrationFeeCents: 500, waitlistAutoPromote: false })
    expect(await refused({ waitlistAutoPromote: true })).toMatch(/paid events move people off the waitlist by hand/)
    db.event.findUnique.mockResolvedValue(null)
    expect(await refused({ title: "x" })).toMatch(/There's no event with id ev-1/)
  })
})

describe("event.update: staleness", () => {
  it("is stale when a field it changes moved, the event went, or the change no longer fits", async () => {
    const { before } = await prepare({ startsAt: "2026-10-29T19:30" })
    const p = parse({ startsAt: "2026-10-29T19:30" })
    expect(await eventUpdateKind.checkStale(p, before)).toBeNull()
    // Someone else's edit to another field is fine...
    db.event.findUnique.mockResolvedValue({ ...GM2, description: "Pizza!" })
    expect(await eventUpdateKind.checkStale(p, before)).toBeNull()
    // ...unless the event no longer passes with this change
    db.event.findUnique.mockResolvedValue({ ...GM2, endsAtUtc: new Date("2026-10-30T00:15:00Z") })
    expect(await eventUpdateKind.checkStale(p, before)).toMatch(/no longer passes the event form's checks: The event can't end before it starts/)
    db.event.findUnique.mockResolvedValue({ ...GM2, startsAtUtc: new Date("2026-10-29T22:00:00Z") })
    expect(await eventUpdateKind.checkStale(p, before)).toBe("The event's start time changed since this was proposed (it's now Thu Oct 29, 5:00 PM CT).")
    db.event.findUnique.mockResolvedValue(null)
    expect(await eventUpdateKind.checkStale(p, before)).toBe("The event was deleted.")
    expect(await eventUpdateKind.checkStale(p, null)).toMatch(/copy of the event is missing/)
  })
})

describe("event.update: apply", () => {
  it("saves each part through the service the admin page uses, as the applying officer", async () => {
    const p = parse({ title: "GM 2: Pizza Night", capacity: 30, checkInEnabled: true, status: "CANCELLED" })
    const { before } = await eventUpdateKind.prepare(p, ctx)
    const result = await eventUpdateKind.apply(p, applyCtx(before))
    expect(events.updateEventDetails).toHaveBeenCalledWith({ eventId: "ev-1", details: { title: "GM 2: Pizza Night" }, publish: null }, actor)
    expect(events.updateEventRegistration).toHaveBeenCalledWith({ eventId: "ev-1", settings: { registrationMax: 30 } }, actor)
    expect(events.updateEventAttendance).toHaveBeenCalledWith({ eventId: "ev-1", attendanceEnabled: true, attendanceOpensAt: null, attendanceClosesAt: null }, actor)
    expect(events.updateEventStatus).toHaveBeenCalledWith({ eventId: "ev-1", status: "CANCELLED" }, actor)
    expect(cache.revalidatePaths).toHaveBeenCalledWith(["/admin/events", "/events", "/events/gm-2", "/admin/events/ev-1/manage"])
    expect(result.summary).toBe("Updated “GM 2”: title, capacity, check-in and status.")
  })

  it("publishes at the moment it's applied, and schedules at the time proposed", async () => {
    db.event.findUnique.mockResolvedValue({ ...GM2, status: "DRAFT", publishedAt: null })
    const publish = parse({ status: "PUBLISHED" })
    await eventUpdateKind.apply(publish, applyCtx((await eventUpdateKind.prepare(publish, ctx)).before))
    expect(events.updateEventDetails).toHaveBeenLastCalledWith({ eventId: "ev-1", details: {}, publish: { status: "PUBLISHED", publishedAt: new Date("2026-10-22T17:00:00Z") } }, actor)
    const schedule = parse({ status: "SCHEDULED", publishAt: "2026-10-25T09:00" })
    await eventUpdateKind.apply(schedule, applyCtx((await eventUpdateKind.prepare(schedule, ctx)).before))
    expect(events.updateEventDetails).toHaveBeenLastCalledWith({ eventId: "ev-1", details: {}, publish: { status: "SCHEDULED", publishedAt: new Date("2026-10-25T14:00:00Z") } }, actor)
    expect(events.updateEventStatus).not.toHaveBeenCalled()
  })

  it("passes times as dates, and reports who moved off the waitlist", async () => {
    events.updateEventRegistration.mockResolvedValue({ ok: true, event: { id: "ev-1", slug: "gm-2" }, promotedUserIds: ["a", "b"], revalidate: [] })
    const p = parse({ startsAt: "2026-10-29T19:00", registrationClosesAt: "2026-10-29T12:00", capacity: 40 })
    const result = await eventUpdateKind.apply(p, applyCtx((await eventUpdateKind.prepare(p, ctx)).before))
    expect(events.updateEventDetails).toHaveBeenCalledWith({ eventId: "ev-1", details: { startsAtUtc: new Date("2026-10-30T00:00:00Z") }, publish: null }, actor)
    expect(events.updateEventRegistration).toHaveBeenCalledWith({ eventId: "ev-1", settings: { registrationClosesAt: new Date("2026-10-29T17:00:00Z"), registrationMax: 40 } }, actor)
    expect(result).toMatchObject({ summary: "Updated “GM 2”: start time, registration closing and capacity. 2 people moved off the waitlist and were notified.", counts: { promoted: 2 } })
  })

  it("says what was saved when a later part fails, and goes stale without its copy or its event", async () => {
    events.updateEventRegistration.mockRejectedValue(new Error("Database is down"))
    const p = parse({ title: "GM 2!", capacity: 30 })
    const { before } = await eventUpdateKind.prepare(p, ctx)
    await expect(eventUpdateKind.apply(p, applyCtx(before))).rejects.toThrow("Saved the event's details, then couldn't save its registration settings: Database is down. Check the event's page.")
    events.updateEventDetails.mockResolvedValue({ ok: false, error: "Another event already uses that URL slug. Pick a different one." })
    await expect(eventUpdateKind.apply(p, applyCtx(before))).rejects.toThrow("Another event already uses that URL slug. Pick a different one.")
    await expect(eventUpdateKind.apply(p, applyCtx({}))).rejects.toBeInstanceOf(StaleProposalError)
    db.event.findUnique.mockResolvedValue(null)
    await expect(eventUpdateKind.apply(p, applyCtx(before))).rejects.toThrow("The event was deleted.")
  })
})
