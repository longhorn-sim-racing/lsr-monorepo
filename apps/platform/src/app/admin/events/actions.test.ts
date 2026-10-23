import { beforeEach, describe, expect, it, vi } from "vitest"

// The actions run for real on top of the event service; only Prisma, the guard and Next are fakes
const db = vi.hoisted(() => {
  const event = { findUnique: vi.fn(), update: vi.fn() }
  return { event, $transaction: vi.fn() }
})
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const registration = vi.hoisted(() => ({ reconcileEventWaitlist: vi.fn(), adminOverrideRegistration: vi.fn(), adminRemoveRegistration: vi.fn() }))
const next = vi.hoisted(() => ({ revalidatePath: vi.fn(), redirect: vi.fn() }))
const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))

vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/services/registration.service", () => registration)
vi.mock("@/server/auth/guards", () => guards)
vi.mock("next/cache", () => ({ revalidatePath: next.revalidatePath }))
vi.mock("next/navigation", () => ({ redirect: next.redirect }))

import { updateEvent, updateEventAttendanceConfig, updateEventRegistrationConfig, updateEventStatus } from "./actions"

function form(fields: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}

const eventForm = (extra: Record<string, string> = {}) =>
  form({
    title: "GM 2",
    slug: "gm-2",
    timezone: "America/Chicago",
    seriesId: "",
    venueId: "",
    startsAtUtc: "2026-10-26T18:00",
    endsAtUtc: "2026-10-26T20:00",
    summary: "",
    description: "",
    heroImageUrl: "",
    streamUrl: "",
    registrationOpensAt: "",
    registrationClosesAt: "",
    registrationMax: "20",
    registrationFee: "",
    registrationFeeCents: "",
    attendanceOpensAt: "",
    attendanceClosesAt: "",
    registrationEnabled: "on",
    ...extra,
  })

const revalidated = () => next.revalidatePath.mock.calls.map(([path]) => path)

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  registration.reconcileEventWaitlist.mockResolvedValue([])
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db))
})

describe("updateEvent", () => {
  beforeEach(() => {
    db.event.findUnique.mockResolvedValue({ registrationMax: 20, registrationFeeCents: null })
    db.event.update.mockResolvedValue({ slug: "gm-2", seriesId: "s1", title: "GM 2" })
  })

  it("saves through the service, refreshes the same pages as before and goes back to the list", async () => {
    await updateEvent("e1", eventForm({ submitAction: "publish" }))

    expect(guards.requireOfficer).toHaveBeenCalled()
    expect(db.event.update.mock.calls[0][0]).toMatchObject({
      where: { id: "e1" },
      data: { title: "GM 2", slug: "gm-2", registrationMax: 20, status: "PUBLISHED", publishedAt: expect.any(Date) },
    })
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "officer-1", summary: "Updated event details for GM 2" }))
    expect(revalidated()).toEqual(["/admin/events", "/events", "/events/gm-2", "/lone-star-cup"])
    expect(next.redirect).toHaveBeenCalledWith("/admin/events")
  })

  it("returns form problems without saving", async () => {
    expect(await updateEvent("e1", eventForm({ title: "" }))).toMatchObject({ ok: false, error: expect.stringContaining("title") })
    expect(await updateEvent("e1", eventForm({ submitAction: "schedule" }))).toEqual({ ok: false, error: "Pick the date and time to publish it" })
    expect(db.event.update).not.toHaveBeenCalled()
    expect(next.redirect).not.toHaveBeenCalled()
  })

  it("returns a taken slug without refreshing or redirecting", async () => {
    const { Prisma } = await import("@prisma/client")
    db.event.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" }))
    expect(await updateEvent("e1", eventForm())).toEqual({ ok: false, error: "Another event already uses that URL slug. Pick a different one." })
    expect(next.revalidatePath).not.toHaveBeenCalled()
    expect(next.redirect).not.toHaveBeenCalled()
  })

  it("stops at the guard", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("Requires one of the following roles: admin, officer"))
    await expect(updateEvent("e1", eventForm())).rejects.toThrow("Requires one of")
    expect(db.event.update).not.toHaveBeenCalled()
  })
})

describe("updateEventStatus", () => {
  it("sets the status, refreshes and goes back to the list", async () => {
    db.event.update.mockResolvedValue({ slug: "gm-2" })
    await updateEventStatus("e1", "CANCELLED")

    expect(db.event.update).toHaveBeenCalledWith({ where: { id: "e1" }, data: { status: "CANCELLED", publishedAt: undefined }, select: { slug: true } })
    expect(revalidated()).toEqual(["/admin/events", "/events", "/events/gm-2"])
    expect(next.redirect).toHaveBeenCalledWith("/admin/events")
  })
})

describe("updateEventRegistrationConfig", () => {
  beforeEach(() => {
    db.event.findUnique.mockResolvedValue({ timezone: "America/Chicago", registrationMax: 10, waitlistAutoPromote: true, registrationFeeCents: null })
    db.event.update.mockResolvedValue({ slug: "gm-2" })
  })

  it("reads the window in the event's time zone, reconciles when capacity goes up and stays on the page", async () => {
    registration.reconcileEventWaitlist.mockResolvedValue(["u1"])
    const result = await updateEventRegistrationConfig(
      "e1",
      form({ registrationEnabled: "on", registrationMax: "15", registrationOpensAt: "2026-10-20T09:00", registrationClosesAt: "", registrationFeeCents: "", waitlistAutoPromote: "on" }),
    )

    expect(result).toEqual({ ok: true })
    expect(db.event.update.mock.calls[0][0].data).toMatchObject({ registrationMax: 15, registrationOpensAt: new Date("2026-10-20T14:00:00Z") })
    expect(registration.reconcileEventWaitlist).toHaveBeenCalledWith("e1")
    expect(audit.createAuditLog.mock.calls[0][0].metadata).toEqual({ updateType: "registration_config", promotedUserIds: ["u1"] })
    expect(revalidated()).toEqual(["/admin/events/e1/manage", "/events", "/events/gm-2"])
    expect(next.redirect).not.toHaveBeenCalled()
  })

  it("returns form problems without saving", async () => {
    const result = await updateEventRegistrationConfig("e1", form({ registrationMax: "0" }))
    expect(result).toMatchObject({ ok: false })
    expect(db.event.update).not.toHaveBeenCalled()
  })
})

describe("updateEventAttendanceConfig", () => {
  it("reads the window in the event's time zone and refreshes the manage page", async () => {
    db.event.findUnique.mockResolvedValue({ timezone: "America/Chicago", attendanceEnabled: false, attendanceReportingMode: "ASSUME_REGISTERED" })
    db.event.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "e1", slug: "gm-2", ...data }))

    await updateEventAttendanceConfig("e1", form({ attendanceEnabled: "on", attendanceOpensAt: "2026-10-26T17:30", attendanceClosesAt: "" }))

    expect(db.event.update).toHaveBeenCalledWith({
      where: { id: "e1" },
      data: {
        attendanceEnabled: true,
        attendanceOpensAt: new Date("2026-10-26T22:30:00Z"),
        attendanceClosesAt: null,
        attendanceReportingMode: "CHECKIN_REQUIRED",
      },
    })
    expect(revalidated()).toEqual(["/admin/events/e1/manage"])
  })
})
