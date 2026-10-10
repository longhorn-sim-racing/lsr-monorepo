import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ user: { findMany: vi.fn() } }))
const service = vi.hoisted(() => ({
  sendBulkNotification: vi.fn(),
  cancelNotification: vi.fn(),
  retryNotification: vi.fn(),
  countEmailRecipients: vi.fn(),
  getEmailUsage: vi.fn(),
  TRANSACTIONAL_HEADROOM: 10,
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))

vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => ({ requireOfficer: vi.fn(async () => ({ id: "officer-1" })) }))
vi.mock("@/server/services/notification.service", () => service)
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/lib/email/settings", () => ({ setSystemSetting: vi.fn(), getSystemSetting: vi.fn(), SETTINGS: {} }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { sendCustomNotification } from "./actions"

/** The composer's form: an immediate in-app + email announcement to all members unless overridden */
function form(fields: Record<string, string | undefined> = {}) {
  const data = new FormData()
  const all: Record<string, string | undefined> = {
    recipientType: "all",
    title: "GM 1 is Thursday",
    body: "ETC 2.108, 7 pm",
    sendInApp: "on",
    sendEmail: "on",
    ...fields,
  }
  for (const [key, value] of Object.entries(all)) if (value !== undefined) data.set(key, value)
  return data
}

const members = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, displayName: `Driver ${i + 1}` }))

beforeEach(() => {
  db.user.findMany.mockResolvedValue(members(20))
  service.getEmailUsage.mockResolvedValue({ sentToday: 0, dailyLimit: 100 })
  service.countEmailRecipients.mockImplementation(async (ids: string[]) => ids.length)
  service.sendBulkNotification.mockImplementation(async ({ userIds, scheduledFor }: { userIds: string[]; scheduledFor?: Date }) => ({
    inApp: userIds.length,
    emails: userIds.length,
    emailsSent: scheduledFor ? 0 : userIds.length,
    emailsFailed: 0,
  }))
})

describe("sendCustomNotification", () => {
  it("sends to every active member and reports what went out", async () => {
    const result = await sendCustomNotification(form())

    expect(result).toEqual({ ok: true, data: { scheduled: false, recipients: 20, emailsSent: 20, emailsFailed: 0 } })
    expect(service.sendBulkNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: members(20).map((m) => m.id), type: "CUSTOM", channels: ["IN_APP", "EMAIL"] })
    )
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityId: "bulk", actorUserId: "officer-1" }))
  })

  describe("checks", () => {
    it("needs a channel, a title and a message", async () => {
      expect(await sendCustomNotification(form({ sendInApp: undefined, sendEmail: undefined }))).toMatchObject({ ok: false, error: /channel/ })
      expect(await sendCustomNotification(form({ title: "  " }))).toMatchObject({ ok: false, error: /title and a message/ })
      expect(service.sendBulkNotification).not.toHaveBeenCalled()
    })

    it("needs a recipient when sending to particular members", async () => {
      expect(await sendCustomNotification(form({ recipientType: "multiple" }))).toMatchObject({ ok: false, error: /recipient/ })
      expect(await sendCustomNotification(form({ recipientType: "single", userIds: "[]" }))).toMatchObject({ ok: false, error: /recipient/ })
      expect(service.sendBulkNotification).not.toHaveBeenCalled()
    })

    it("reads a schedule time as Central time", async () => {
      const result = await sendCustomNotification(form({ scheduledFor: "2026-10-15T10:00" }))
      expect(result).toMatchObject({ ok: true, data: { scheduled: true } })
      expect(service.sendBulkNotification.mock.calls[0][0].scheduledFor).toEqual(new Date("2026-10-15T15:00:00Z"))
    })
  })

  describe("daily email limit", () => {
    it("stops a send that would use up the emails kept for confirmations and receipts", async () => {
      // 85 sent + 10 kept back leaves 5; this send needs 20
      service.getEmailUsage.mockResolvedValue({ sentToday: 85, dailyLimit: 100 })

      const result = await sendCustomNotification(form())

      expect(result).toMatchObject({ ok: false })
      expect(!result.ok && result.error).toMatch(/only 5 of today's 100 are left \(85 sent, 10 kept/)
      expect(!result.ok && result.error).toMatch(/resets at 7 pm Central/)
      expect(service.sendBulkNotification).not.toHaveBeenCalled()
    })

    it("allows a send that fits", async () => {
      service.getEmailUsage.mockResolvedValue({ sentToday: 70, dailyLimit: 100 })
      await expect(sendCustomNotification(form())).resolves.toMatchObject({ ok: true })
    })

    it("counts only members who'd actually get the email", async () => {
      service.getEmailUsage.mockResolvedValue({ sentToday: 85, dailyLimit: 100 })
      service.countEmailRecipients.mockResolvedValue(4)
      await expect(sendCustomNotification(form())).resolves.toMatchObject({ ok: true })
      expect(service.countEmailRecipients).toHaveBeenCalledWith(members(20).map((m) => m.id), "CUSTOM")
    })

    it("says so when a send can't fit in any single day", async () => {
      db.user.findMany.mockResolvedValue(members(250))
      const result = await sendCustomNotification(form())
      expect(!result.ok && result.error).toMatch(/250 emails, more than the 90 a day an announcement can use \(the plan's 100, minus 10/)
    })

    it("counts the kept-back emails against a send that's just under the plan's limit", async () => {
      db.user.findMany.mockResolvedValue(members(95))
      const result = await sendCustomNotification(form())
      expect(!result.ok && result.error).toMatch(/95 emails, more than the 90 a day/)
      expect(service.sendBulkNotification).not.toHaveBeenCalled()
    })

    it("lets an officer send anyway", async () => {
      service.getEmailUsage.mockResolvedValue({ sentToday: 99, dailyLimit: 100 })
      await expect(sendCustomNotification(form({ sendAnyway: "on" }))).resolves.toMatchObject({ ok: true })
      expect(service.getEmailUsage).not.toHaveBeenCalled()
    })

    it("doesn't check in-app-only or scheduled sends, or a plan with no limit", async () => {
      service.getEmailUsage.mockResolvedValue({ sentToday: 99, dailyLimit: 100 })
      await expect(sendCustomNotification(form({ sendEmail: undefined }))).resolves.toMatchObject({ ok: true })
      await expect(sendCustomNotification(form({ scheduledFor: "2026-10-15T10:00" }))).resolves.toMatchObject({ ok: true })
      expect(service.getEmailUsage).not.toHaveBeenCalled()

      service.getEmailUsage.mockResolvedValue({ sentToday: 5000, dailyLimit: null })
      await expect(sendCustomNotification(form())).resolves.toMatchObject({ ok: true })
    })

    it("uses singular wording for one email", async () => {
      db.user.findMany.mockResolvedValue(members(1))
      service.getEmailUsage.mockResolvedValue({ sentToday: 90, dailyLimit: 100 })
      const result = await sendCustomNotification(form())
      expect(!result.ok && result.error).toMatch(/send 1 email,/)
    })
  })

  it("names the members in the audit log, looked up before sending", async () => {
    db.user.findMany.mockResolvedValue([{ id: "u7", displayName: "Riley Park" }])

    await sendCustomNotification(form({ recipientType: "single", userIds: JSON.stringify(["u7"]) }))

    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "custom", targetUserId: "u7", summary: expect.stringContaining("Riley Park") })
    )
    expect(db.user.findMany.mock.invocationCallOrder[0]).toBeLessThan(service.sendBulkNotification.mock.invocationCallOrder[0])
  })
})
