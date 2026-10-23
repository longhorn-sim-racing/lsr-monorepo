import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"

// A stand-in for the Prisma client: only what the event and attendance services touch
const db = vi.hoisted(() => {
  const event = { findUnique: vi.fn(), update: vi.fn() }
  return { event, $transaction: vi.fn() }
})
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const registration = vi.hoisted(() => ({ reconcileEventWaitlist: vi.fn() }))

vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/services/registration.service", () => registration)

import {
  SLUG_TAKEN,
  updateEventAttendance,
  updateEventDetails,
  updateEventRegistration,
  updateEventStatus,
  type EventDetails,
} from "./event.service"

const officer = { userId: "officer-1" }
const viaJack = { userId: "officer-2", auditMetadata: { via: "jack", proposalId: "p1", roomId: "r1", proposedFor: "officer-1" } }

/** Everything the admin event form sends, as parseEventForm returns it */
const details = (extra: Partial<EventDetails> = {}): EventDetails => ({
  title: "GM 2",
  slug: "gm-2",
  seriesId: null,
  venueId: null,
  timezone: "America/Chicago",
  startsAtUtc: new Date("2026-10-26T23:00:00Z"),
  endsAtUtc: new Date("2026-10-27T01:00:00Z"),
  summary: "",
  description: "",
  heroImageUrl: null,
  streamUrl: null,
  registrationEnabled: true,
  registrationOpensAt: null,
  registrationClosesAt: null,
  registrationMax: 20,
  registrationWaitlistEnabled: true,
  registrationFeeCents: null,
  attendanceEnabled: false,
  attendanceOpensAt: null,
  attendanceClosesAt: null,
  ...extra,
})

const clash = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })

beforeEach(() => {
  registration.reconcileEventWaitlist.mockResolvedValue([])
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db))
})

describe("updateEventDetails", () => {
  beforeEach(() => {
    db.event.findUnique.mockResolvedValue({ registrationMax: 20, registrationFeeCents: null })
    db.event.update.mockImplementation(async ({ data }: { data: { title?: string; slug?: string } }) => ({
      slug: data.slug ?? "gm-2",
      seriesId: null,
      title: data.title ?? "GM 2",
    }))
  })

  it("saves the fields, audits them and lists the pages to refresh", async () => {
    const result = await updateEventDetails({ eventId: "e1", details: details() }, officer)

    expect(db.event.update).toHaveBeenCalledWith({ where: { id: "e1" }, data: details(), select: { slug: true, seriesId: true, title: true } })
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "officer-1",
      actionType: "UPDATE",
      entityType: "EVENT",
      entityId: "e1",
      summary: "Updated event details for GM 2",
      after: details(),
      metadata: undefined,
    })
    expect(registration.reconcileEventWaitlist).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: true,
      event: { id: "e1", slug: "gm-2", seriesId: null, title: "GM 2" },
      promotedUserIds: [],
      revalidate: ["/admin/events", "/events", "/events/gm-2"],
    })
  })

  it("refreshes the series page for an event in a series", async () => {
    db.event.update.mockResolvedValue({ slug: "lsc-r3", seriesId: "s1", title: "LSC Round 3" })
    const result = await updateEventDetails({ eventId: "e1", details: details() }, officer)
    expect(result).toMatchObject({ ok: true, revalidate: ["/admin/events", "/events", "/events/lsc-r3", "/lone-star-cup"] })
  })

  it("makes people check in when check-in is turned on", async () => {
    await updateEventDetails({ eventId: "e1", details: details({ attendanceEnabled: true }) }, officer)
    expect(db.event.update.mock.calls[0][0].data).toMatchObject({ attendanceEnabled: true, attendanceReportingMode: "CHECKIN_REQUIRED" })
  })

  it("sets the status from the publish buttons, and a draft keeps its publish date", async () => {
    const publishedAt = new Date("2026-10-20T15:00:00Z")
    await updateEventDetails({ eventId: "e1", details: details(), publish: { status: "PUBLISHED", publishedAt } }, officer)
    expect(db.event.update.mock.calls[0][0].data).toMatchObject({ status: "PUBLISHED", publishedAt })

    await updateEventDetails({ eventId: "e1", details: details(), publish: { status: "DRAFT", publishedAt: null } }, officer)
    const draft = db.event.update.mock.calls[1][0].data
    expect(draft.status).toBe("DRAFT")
    expect("publishedAt" in draft).toBe(false)

    await updateEventDetails({ eventId: "e1", details: details(), publish: null }, officer)
    expect("status" in db.event.update.mock.calls[2][0].data).toBe(false)
  })

  it.each([
    ["capacity goes up", { registrationMax: 20, registrationFeeCents: null }, { registrationMax: 25 }],
    ["capacity becomes unlimited", { registrationMax: 20, registrationFeeCents: null }, { registrationMax: null }],
    ["the fee is removed", { registrationMax: 20, registrationFeeCents: 1000 }, { registrationFeeCents: null }],
  ])("reconciles the waitlist when %s", async (_label, before, change) => {
    db.event.findUnique.mockResolvedValue(before)
    registration.reconcileEventWaitlist.mockResolvedValue(["u1", "u2"])

    const result = await updateEventDetails({ eventId: "e1", details: details(change) }, officer)

    expect(registration.reconcileEventWaitlist).toHaveBeenCalledWith("e1")
    expect(result).toMatchObject({ ok: true, promotedUserIds: ["u1", "u2"] })
  })

  it.each([
    ["capacity goes down", { registrationMax: 20, registrationFeeCents: null }, { registrationMax: 10 }],
    ["capacity was already unlimited", { registrationMax: null, registrationFeeCents: null }, { registrationMax: 30 }],
    ["the fee changes but stays", { registrationMax: 20, registrationFeeCents: 1000 }, { registrationFeeCents: 500 }],
  ])("leaves the waitlist when %s", async (_label, before, change) => {
    db.event.findUnique.mockResolvedValue(before)
    await updateEventDetails({ eventId: "e1", details: details(change) }, officer)
    expect(registration.reconcileEventWaitlist).not.toHaveBeenCalled()
  })

  it("changes only the fields given, and leaving capacity out never reconciles", async () => {
    db.event.findUnique.mockResolvedValue({ registrationMax: 20, registrationFeeCents: 1000 })
    const result = await updateEventDetails({ eventId: "e1", details: { startsAtUtc: new Date("2026-10-27T00:00:00Z") } }, officer)

    expect(db.event.update.mock.calls[0][0].data).toEqual({ startsAtUtc: new Date("2026-10-27T00:00:00Z") })
    expect(registration.reconcileEventWaitlist).not.toHaveBeenCalled()
    // The audit summary names the event even when the title isn't part of the change
    expect(audit.createAuditLog.mock.calls[0][0].summary).toBe("Updated event details for GM 2")
    expect(result.ok).toBe(true)
  })

  it("says so when the slug is taken, without auditing", async () => {
    db.event.update.mockRejectedValue(clash())
    expect(await updateEventDetails({ eventId: "e1", details: details() }, officer)).toEqual({ ok: false, error: SLUG_TAKEN })
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("throws anything else", async () => {
    db.event.update.mockRejectedValue(new Error("connection lost"))
    await expect(updateEventDetails({ eventId: "e1", details: details() }, officer)).rejects.toThrow("connection lost")
  })

  it("adds a proposal's ids to the audit entry", async () => {
    await updateEventDetails({ eventId: "e1", details: details() }, viaJack)
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "officer-2", metadata: { via: "jack", proposalId: "p1", roomId: "r1", proposedFor: "officer-1" } }),
    )
  })
})

describe("updateEventStatus", () => {
  beforeEach(() => db.event.update.mockResolvedValue({ slug: "gm-2" }))

  it("sets the status, audits it and lists the pages to refresh", async () => {
    const publishedAt = new Date("2026-10-20T15:00:00Z")
    const result = await updateEventStatus({ eventId: "e1", status: "PUBLISHED", publishedAt }, officer)

    expect(db.event.update).toHaveBeenCalledWith({ where: { id: "e1" }, data: { status: "PUBLISHED", publishedAt }, select: { slug: true } })
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "officer-1",
      actionType: "UPDATE",
      entityType: "EVENT",
      entityId: "e1",
      summary: "Updated event status to PUBLISHED",
      after: { status: "PUBLISHED", publishedAt },
      metadata: undefined,
    })
    expect(result).toEqual({ ok: true, event: { id: "e1", slug: "gm-2" }, revalidate: ["/admin/events", "/events", "/events/gm-2"] })
  })

  it("leaves the publish date when none is given", async () => {
    await updateEventStatus({ eventId: "e1", status: "CANCELLED" }, officer)
    expect(db.event.update.mock.calls[0][0].data).toEqual({ status: "CANCELLED", publishedAt: undefined })
  })
})

describe("updateEventRegistration", () => {
  const settings = {
    registrationEnabled: true,
    registrationOpensAt: null,
    registrationClosesAt: null,
    registrationMax: 20,
    registrationWaitlistEnabled: true,
    waitlistAutoPromote: true,
    registrationFeeCents: null,
  }

  beforeEach(() => {
    db.event.findUnique.mockResolvedValue({ registrationMax: 20, waitlistAutoPromote: true, registrationFeeCents: null })
    db.event.update.mockResolvedValue({ slug: "gm-2" })
  })

  it("saves the settings, audits them and lists the pages to refresh", async () => {
    const result = await updateEventRegistration({ eventId: "e1", settings }, officer)

    expect(db.event.update).toHaveBeenCalledWith({ where: { id: "e1" }, data: settings, select: { slug: true } })
    expect(registration.reconcileEventWaitlist).not.toHaveBeenCalled()
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "officer-1",
      actionType: "UPDATE",
      entityType: "EVENT",
      entityId: "e1",
      summary: "Updated registration configuration for event e1",
      metadata: { updateType: "registration_config", promotedUserIds: [] },
      after: settings,
    })
    expect(result).toEqual({
      ok: true,
      event: { id: "e1", slug: "gm-2" },
      promotedUserIds: [],
      revalidate: ["/admin/events/e1/manage", "/events", "/events/gm-2"],
    })
  })

  it("reconciles when auto-promotion is switched on, and audits who was promoted", async () => {
    db.event.findUnique.mockResolvedValue({ registrationMax: 20, waitlistAutoPromote: false, registrationFeeCents: null })
    registration.reconcileEventWaitlist.mockResolvedValue(["u7"])

    const result = await updateEventRegistration({ eventId: "e1", settings }, officer)

    expect(registration.reconcileEventWaitlist).toHaveBeenCalledWith("e1")
    expect(audit.createAuditLog.mock.calls[0][0].metadata).toEqual({ updateType: "registration_config", promotedUserIds: ["u7"] })
    expect(result).toMatchObject({ promotedUserIds: ["u7"] })
  })

  it("reconciles when capacity goes up or the fee is removed", async () => {
    await updateEventRegistration({ eventId: "e1", settings: { ...settings, registrationMax: 30 } }, officer)
    db.event.findUnique.mockResolvedValue({ registrationMax: 20, waitlistAutoPromote: true, registrationFeeCents: 1500 })
    await updateEventRegistration({ eventId: "e1", settings }, officer)
    expect(registration.reconcileEventWaitlist).toHaveBeenCalledTimes(2)
  })

  it("doesn't reconcile when auto-promotion is switched off", async () => {
    await updateEventRegistration({ eventId: "e1", settings: { ...settings, waitlistAutoPromote: false } }, officer)
    expect(registration.reconcileEventWaitlist).not.toHaveBeenCalled()
  })

  it("keeps its own audit fields ahead of a proposal's", async () => {
    await updateEventRegistration({ eventId: "e1", settings }, { userId: "officer-2", auditMetadata: { via: "jack", updateType: "spoofed" } })
    expect(audit.createAuditLog.mock.calls[0][0].metadata).toEqual({ via: "jack", updateType: "registration_config", promotedUserIds: [] })
  })
})

describe("updateEventAttendance", () => {
  const opensAt = new Date("2026-10-26T22:30:00Z")
  const closesAt = new Date("2026-10-27T01:00:00Z")

  beforeEach(() => {
    db.event.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "e1", slug: "gm-2", ...data }))
  })

  it("turning check-in on makes people check in, audited by the attendance service", async () => {
    db.event.findUnique.mockResolvedValue({
      attendanceEnabled: false,
      attendanceOpensAt: null,
      attendanceClosesAt: null,
      attendanceReportingMode: "ASSUME_REGISTERED",
    })

    const result = await updateEventAttendance({ eventId: "e1", attendanceEnabled: true, attendanceOpensAt: opensAt, attendanceClosesAt: closesAt }, officer)

    expect(db.event.update).toHaveBeenCalledWith({
      where: { id: "e1" },
      data: { attendanceEnabled: true, attendanceOpensAt: opensAt, attendanceClosesAt: closesAt, attendanceReportingMode: "CHECKIN_REQUIRED" },
    })
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "officer-1",
        actionType: "ATTENDANCE_CONFIG_UPDATE",
        entityType: "EVENT",
        entityId: "e1",
        metadata: { attendanceEnabled: true, attendanceOpensAt: opensAt, attendanceClosesAt: closesAt, reportingMode: "CHECKIN_REQUIRED" },
      }),
      db,
    )
    expect(result).toEqual({
      ok: true,
      event: { id: "e1", slug: "gm-2", attendanceReportingMode: "CHECKIN_REQUIRED" },
      revalidate: ["/admin/events/e1/manage"],
    })
  })

  it("turning it off keeps the reporting mode", async () => {
    db.event.findUnique.mockResolvedValue({
      attendanceEnabled: true,
      attendanceOpensAt: opensAt,
      attendanceClosesAt: closesAt,
      attendanceReportingMode: "CHECKIN_REQUIRED",
    })
    const result = await updateEventAttendance({ eventId: "e1", attendanceEnabled: false, attendanceOpensAt: null, attendanceClosesAt: null }, officer)
    expect(result.event.attendanceReportingMode).toBe("CHECKIN_REQUIRED")
  })

  it("adds a proposal's ids to the audit entry", async () => {
    db.event.findUnique.mockResolvedValue({ attendanceEnabled: true, attendanceReportingMode: "CHECKIN_REQUIRED" })
    await updateEventAttendance({ eventId: "e1", attendanceEnabled: true, attendanceOpensAt: null, attendanceClosesAt: null }, viaJack)
    expect(audit.createAuditLog.mock.calls[0][0].metadata).toMatchObject({ via: "jack", proposalId: "p1", reportingMode: "CHECKIN_REQUIRED" })
  })

  it("throws when the event is gone", async () => {
    db.event.findUnique.mockResolvedValue(null)
    await expect(
      updateEventAttendance({ eventId: "e1", attendanceEnabled: true, attendanceOpensAt: null, attendanceClosesAt: null }, officer),
    ).rejects.toThrow("Event not found")
  })
})
