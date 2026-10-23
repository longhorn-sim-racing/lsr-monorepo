import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  event: { findUnique: vi.fn() },
  eventRegistration: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  eventAttendance: { findMany: vi.fn() },
}))
const attendance = vi.hoisted(() => ({ checkInUser: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePaths: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/attendance.service", () => attendance)
vi.mock("@/server/cache/revalidate-public", () => cache)

import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { attendanceCheckinKind, attendanceCheckinSchema } from "./attendance-checkin"

const person = (id: string, displayName: string, handle: string) => ({ id, displayName, handle, email: `${handle}@example.com` })
const ana = person("a", "Ana Torres", "ana-torres")
const matt = person("m", "Matthew Gray", "matt-gray")
const mattB = person("mb", "Matt Brown", "matt-brown")
const jose = person("j", "José Núñez", "jose-nunez")
const walk = person("w", "Wanda Walker", "wanda-walker")

const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const meta = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" }
const applyCtx = (before: unknown, selectedRows?: string[]): ProposalApplyContext => ({ officer: { userId: "u2", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: meta, selectedRows })
const checkin = (names: string[]) => attendanceCheckinSchema.parse({ eventId: "ev-1", names })

beforeEach(() => {
  db.event.findUnique.mockResolvedValue({ id: "ev-1", title: "GM 2" })
  db.eventRegistration.findMany.mockResolvedValue([
    { status: "REGISTERED", user: ana },
    { status: "REGISTERED", user: matt },
    { status: "REGISTERED", user: mattB },
    { status: "WAITLISTED", user: jose },
  ])
  db.user.findMany.mockResolvedValue([ana, matt, mattB, jose, walk])
  db.eventAttendance.findMany.mockResolvedValue([{ userId: "a" }])
  attendance.checkInUser.mockResolvedValue({ alreadyCheckedIn: false, attendanceId: "att" })
})

describe("attendance.checkin: prepare", () => {
  it("matches names to the event's people first, and lists ambiguous and unmatched names as rows", async () => {
    const prepared = await attendanceCheckinKind.prepare(checkin(["jose nunez", "Matt", "Wanda Walker", "Ana Torres", "Zed Nobody", "JOSE NUNEZ"]), ctx)
    expect(prepared.targetId).toBe("ev-1")
    expect(prepared.view.rows).toEqual([
      { id: "0:j", label: "jose nunez", detail: "José Núñez (@jose-nunez) · on the waitlist", status: "matched" },
      { id: "1:m", label: "Matt", detail: "Could be Matthew Gray (@matt-gray) · registered", status: "ambiguous" },
      { id: "1:mb", label: "Matt", detail: "Could be Matt Brown (@matt-brown) · registered", status: "ambiguous" },
      { id: "2:w", label: "Wanda Walker", detail: "Wanda Walker (@wanda-walker) · not registered", status: "matched" },
      { id: "4:none", label: "Zed Nobody", detail: "No member matches. Check the spelling, or give their handle or email.", status: "unmatched" },
    ])
    expect(prepared.view.people).toEqual([{ name: "Ana Torres", detail: "Ana Torres is already checked in" }])
    expect(prepared.before).toEqual({ eventTitle: "GM 2", matched: ["0:j", "2:w"] })
    expect(prepared.view.title).toBe("Check in 4 people at “GM 2”")
    expect(prepared.view.summary).toBe(
      "Applying it checks in the people left ticked below at “GM 2”, as manual check-ins by the officer who applies it. 2 names matched, 1 name could be more than one member (tick the right one), 1 name matched nobody and can't be checked in. 1 person is already checked in.",
    )
  })

  it("flags two names for the same member, and refuses a list of people already in", async () => {
    const prepared = await attendanceCheckinKind.prepare(checkin(["Wanda Walker", "@wanda-walker"]), ctx)
    expect(prepared.view.rows?.[1]).toEqual({ id: "1:w", label: "@wanda-walker", detail: "Wanda Walker (@wanda-walker) · not registered. Same member as “Wanda Walker”", status: "ambiguous" })
    await expect(attendanceCheckinKind.prepare(checkin(["Ana Torres"]), ctx)).rejects.toThrow("Everyone named is already checked in at “GM 2”.")
    await expect(attendanceCheckinKind.prepare(checkin(["Ana Torres", "Zed Nobody", "Q"]), ctx)).rejects.toThrow("No member matches these names: Zed Nobody, Q. Check the spelling, or give their handles or emails.")
    db.event.findUnique.mockResolvedValue(null)
    await expect(attendanceCheckinKind.prepare(checkin(["x"]), ctx)).rejects.toBeInstanceOf(ProposalInputError)
  })
})

describe("attendance.checkin: apply", () => {
  const before = { eventTitle: "GM 2", matched: ["0:j", "2:w"] }

  it("checks in each ticked member through the attendance service, with the proposal on its audit entry", async () => {
    attendance.checkInUser.mockImplementation(async (_e: string, userId: string) => ({ alreadyCheckedIn: userId === "j", attendanceId: "att" }))
    db.user.findMany.mockResolvedValue([{ id: "j" }, { id: "w" }, { id: "mb" }])
    const result = await attendanceCheckinKind.apply(checkin(["x"]), applyCtx(before, ["0:j", "1:mb", "2:w", "4:none"]))
    expect(attendance.checkInUser.mock.calls).toEqual([
      ["ev-1", "j", "MANUAL", "u2", meta],
      ["ev-1", "mb", "MANUAL", "u2", meta],
      ["ev-1", "w", "MANUAL", "u2", meta],
    ])
    expect(cache.revalidatePaths).toHaveBeenCalledWith(["/admin/events/ev-1/manage"])
    expect(result).toEqual({
      summary: "Checked in 2 people at “GM 2” (1 was already checked in; 1 name with no match skipped).",
      links: [{ title: "Registration and check-in", url: "/admin/events/ev-1/manage" }],
      appliedRows: ["0:j", "1:mb", "2:w"],
      counts: { checkedIn: 2, alreadyIn: 1, skipped: 1 },
    })
  })

  it("applies only the matched names when nothing was picked, and skips accounts that are gone", async () => {
    db.user.findMany.mockResolvedValue([{ id: "j" }])
    const result = await attendanceCheckinKind.apply(checkin(["x"]), applyCtx(before))
    expect(attendance.checkInUser).toHaveBeenCalledTimes(1)
    expect(result.summary).toBe("Checked in 1 person at “GM 2” (1 account no longer there).")
    await expect(attendanceCheckinKind.apply(checkin(["x"]), applyCtx(before, ["4:none"]))).rejects.toThrow("None of the ticked names matched a member")
    await expect(attendanceCheckinKind.apply(checkin(["x"]), applyCtx(null))).rejects.toBeInstanceOf(StaleProposalError)
  })

  it("goes stale when the event is deleted", async () => {
    expect(await attendanceCheckinKind.checkStale(checkin(["x"]), before)).toBeNull()
    db.event.findUnique.mockResolvedValue(null)
    expect(await attendanceCheckinKind.checkStale(checkin(["x"]), before)).toBe("The event “GM 2” was deleted.")
  })
})
