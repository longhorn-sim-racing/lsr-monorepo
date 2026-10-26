import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = vi.hoisted(() => ({
  event: { findUnique: vi.fn() },
  eventAttendance: { findUnique: vi.fn(), create: vi.fn() },
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } }))
vi.mock("@/server/audit/log", () => audit)

import { checkInUser } from "./attendance.service"

beforeEach(() => {
  tx.event.findUnique.mockResolvedValue({ attendanceEnabled: false, attendanceOpensAt: null, attendanceClosesAt: null, title: "GM 2" })
  tx.eventAttendance.findUnique.mockResolvedValue(null)
  tx.eventAttendance.create.mockResolvedValue({ id: "att-1" })
})

describe("checkInUser (manual)", () => {
  it("records the check-in by the officer, with extra metadata on its audit entry", async () => {
    const result = await checkInUser("ev-1", "u-ana", "MANUAL", "u-gray", { via: "jack", proposalId: "p1" })
    expect(result).toEqual({ alreadyCheckedIn: false, attendanceId: "att-1" })
    expect(tx.eventAttendance.create).toHaveBeenCalledWith({ data: { eventId: "ev-1", userId: "u-ana", method: "MANUAL", checkedInByUserId: "u-gray" } })
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "u-gray", actionType: "CHECKIN", targetUserId: "u-ana", metadata: { via: "jack", proposalId: "p1", eventId: "ev-1", userId: "u-ana", method: "MANUAL", eventTitle: "GM 2" } }),
      tx,
    )
  })

  it("writes the same entry as before without it, and nothing for someone already in", async () => {
    await checkInUser("ev-1", "u-ana", "MANUAL", "u-gray")
    expect(audit.createAuditLog.mock.calls[0][0].metadata).toEqual({ eventId: "ev-1", userId: "u-ana", method: "MANUAL", eventTitle: "GM 2" })
    tx.eventAttendance.findUnique.mockResolvedValue({ id: "att-0" })
    expect(await checkInUser("ev-1", "u-ana", "MANUAL", "u-gray")).toEqual({ alreadyCheckedIn: true, attendanceId: "att-0" })
    expect(audit.createAuditLog).toHaveBeenCalledTimes(1)
  })
})
