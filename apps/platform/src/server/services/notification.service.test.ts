import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A stand-in for the Prisma client: only what the notification service touches
const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  notification: {
    create: vi.fn(),
    createManyAndReturn: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn(),
}))
const email = vi.hoisted(() => ({ sendEmail: vi.fn(), sendBatchEmails: vi.fn() }))

vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/lib/email/resend", () => ({ ...email, MAX_BATCH_EMAILS: 100 }))

import {
  countEmailRecipients,
  getEmailUsage,
  processScheduledNotifications,
  retryNotification,
  sendBulkNotification,
  sendNotification,
  type NotificationType,
} from "./notification.service"

type Prefs = {
  emailRegistration: boolean
  emailWaitlistPromotion: boolean
  emailEventReminder: boolean
  emailEventPosted: boolean
  emailResultsPosted: boolean
}
const ALL_OFF: Prefs = {
  emailRegistration: false,
  emailWaitlistPromotion: false,
  emailEventReminder: false,
  emailEventPosted: false,
  emailResultsPosted: false,
}
const member = (id: string, extra: { marketingOptIn?: boolean; notificationPrefs?: Prefs | null } = {}) => ({
  id,
  email: `${id}@utexas.edu`,
  marketingOptIn: true,
  notificationPrefs: null,
  ...extra,
})

/** Rows as createManyAndReturn would give them back, with ids and the user included */
function returnCreatedRows() {
  db.notification.createManyAndReturn.mockImplementation(async ({ data }: { data: Record<string, unknown>[] }) =>
    data.map((row, i) => ({
      id: `n${i + 1}`,
      actionUrl: null,
      metadata: null,
      ...row,
      user: { id: row.userId, email: `${row.userId}@utexas.edu` },
    }))
  )
}

/** The data each notification row was last updated with, by id */
function finalUpdates() {
  return Object.fromEntries(
    db.notification.update.mock.calls.map((call) => {
      const { where, data } = call[0] as { where: { id: string }; data: Record<string, unknown> }
      return [where.id, data]
    })
  )
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.longhornsimracing.org")
  db.notification.update.mockImplementation(async (args: unknown) => args)
  db.$transaction.mockImplementation(async (operations: Promise<unknown>[]) => Promise.all(operations))
  db.notification.findMany.mockResolvedValue([])
  db.notification.updateMany.mockResolvedValue({ count: 1 })
  email.sendEmail.mockResolvedValue({ success: true, messageId: "msg_single" })
  email.sendBatchEmails.mockImplementation(async (emails: unknown[]) =>
    emails.map((_, i) => ({ success: true, messageId: `msg_${i + 1}` }))
  )
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
})

describe("who gets an email", () => {
  async function gets(type: NotificationType, user: ReturnType<typeof member>) {
    db.user.findMany.mockResolvedValue([user])
    return (await countEmailRecipients([user.id], type)) === 1
  }

  it("keeps the marketing opt-out to announcements", async () => {
    const optedOut = member("u1", { marketingOptIn: false })
    for (const type of ["EVENT_POSTED", "REGISTRATION_OPENED", "RESULTS_POSTED", "CUSTOM"] as const) {
      expect(await gets(type, optedOut), type).toBe(false)
    }
    for (const type of ["REGISTRATION_CONFIRMED", "WAITLIST_PROMOTED", "DUES_CONFIRMED", "LEAGUE_REGISTERED"] as const) {
      expect(await gets(type, optedOut), type).toBe(true)
    }
  })

  it("defaults to the essentials for members who never set preferences", async () => {
    const fresh = member("u1")
    for (const type of ["REGISTRATION_CONFIRMED", "WAITLIST_PROMOTED", "DUES_CONFIRMED", "LEAGUE_REGISTERED", "CUSTOM"] as const) {
      expect(await gets(type, fresh), type).toBe(true)
    }
    for (const type of ["EVENT_REMINDER_24H", "EVENT_POSTED", "REGISTRATION_OPENED", "RESULTS_POSTED"] as const) {
      expect(await gets(type, fresh), type).toBe(false)
    }
  })

  it("follows each preference toggle", async () => {
    const cases: [NotificationType, keyof Prefs][] = [
      ["REGISTRATION_CONFIRMED", "emailRegistration"],
      ["WAITLIST_PROMOTED", "emailWaitlistPromotion"],
      ["EVENT_REMINDER_24H", "emailEventReminder"],
      ["EVENT_POSTED", "emailEventPosted"],
      ["REGISTRATION_OPENED", "emailEventPosted"],
      ["RESULTS_POSTED", "emailResultsPosted"],
    ]
    for (const [type, pref] of cases) {
      expect(await gets(type, member("u1", { notificationPrefs: { ...ALL_OFF, [pref]: true } })), `${type} on`).toBe(true)
      expect(await gets(type, member("u1", { notificationPrefs: ALL_OFF })), `${type} off`).toBe(false)
    }
  })

  it("sends officer announcements to anyone opted in to marketing, whatever their toggles", async () => {
    expect(await gets("CUSTOM", member("u1", { notificationPrefs: ALL_OFF }))).toBe(true)
  })
})

describe("sendNotification", () => {
  it("always emails a payment receipt, even to someone who turned that email off", async () => {
    db.user.findUnique.mockResolvedValue(member("u1", { marketingOptIn: false, notificationPrefs: ALL_OFF }))

    await sendNotification({ userId: "u1", type: "REGISTRATION_CONFIRMED", title: "Paid", body: "Receipt", channels: ["IN_APP", "EMAIL"], receipt: true })

    expect(db.notification.create.mock.calls.map(([args]) => args.data.channel)).toEqual(["IN_APP", "EMAIL"])
  })

  it("respects the member's settings for anything that isn't a receipt", async () => {
    db.user.findUnique.mockResolvedValue(member("u1", { notificationPrefs: ALL_OFF }))

    await sendNotification({ userId: "u1", type: "REGISTRATION_CONFIRMED", title: "Registered", body: "See you", channels: ["IN_APP", "EMAIL"] })

    expect(db.notification.create.mock.calls.map(([args]) => args.data.channel)).toEqual(["IN_APP"])
  })

  it("does nothing for an unknown user", async () => {
    db.user.findUnique.mockResolvedValue(null)
    await sendNotification({ userId: "ghost", type: "CUSTOM", title: "Hi", body: "Hi", channels: ["EMAIL"] })
    expect(db.notification.create).not.toHaveBeenCalled()
  })
})

describe("sendBulkNotification", () => {
  beforeEach(returnCreatedRows)

  it("creates every row in one query, already claimed, and skips opted-out emails", async () => {
    db.user.findMany.mockResolvedValue([member("u1"), member("u2", { marketingOptIn: false })])

    const counts = await sendBulkNotification({
      userIds: ["u1", "u2"],
      type: "CUSTOM",
      title: "GM 1 is Thursday",
      body: "See you there",
      channels: ["IN_APP", "EMAIL"],
    })

    expect(counts).toEqual({ inApp: 2, emails: 1 })
    expect(db.notification.createManyAndReturn).toHaveBeenCalledTimes(1)
    const rows = db.notification.createManyAndReturn.mock.calls[0][0].data
    expect(rows).toHaveLength(3)
    expect(rows.find((r: { channel: string }) => r.channel === "EMAIL")).toMatchObject({ userId: "u1", status: "SENT", sentAt: null })
    for (const row of rows.filter((r: { channel: string }) => r.channel === "IN_APP")) {
      expect(row).toMatchObject({ status: "SENT", sentAt: expect.any(Date) })
    }
  })

  it("sends a single email with one call and records the message id", async () => {
    db.user.findMany.mockResolvedValue([member("u1")])

    await sendBulkNotification({ userIds: ["u1"], type: "CUSTOM", title: "Hi", body: "Hi", channels: ["EMAIL"] })

    expect(email.sendEmail).toHaveBeenCalledTimes(1)
    expect(email.sendBatchEmails).not.toHaveBeenCalled()
    expect(finalUpdates().n1).toMatchObject({ status: "SENT", sentAt: expect.any(Date), emailMessageId: "msg_single" })
  })

  it("splits 250 emails into batch calls of 100, 100 and 50", async () => {
    vi.useFakeTimers()
    const users = Array.from({ length: 250 }, (_, i) => member(`u${i + 1}`))
    db.user.findMany.mockResolvedValue(users)

    const sending = sendBulkNotification({ userIds: users.map((u) => u.id), type: "CUSTOM", title: "Hi", body: "Hi", channels: ["EMAIL"] })
    await vi.runAllTimersAsync()
    await expect(sending).resolves.toEqual({ inApp: 0, emails: 250 })

    expect(email.sendBatchEmails.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 50])
    expect(email.sendEmail).not.toHaveBeenCalled()
    expect(db.notification.update).toHaveBeenCalledTimes(250)
  })

  it("marks only the emails Resend rejected as failed", async () => {
    db.user.findMany.mockResolvedValue([member("u1"), member("u2"), member("u3")])
    email.sendBatchEmails.mockResolvedValue([
      { success: true, messageId: "a" },
      { success: false, error: "Invalid `to` field" },
      { success: true, messageId: "c" },
    ])

    await sendBulkNotification({ userIds: ["u1", "u2", "u3"], type: "CUSTOM", title: "Hi", body: "Hi", channels: ["EMAIL"] })

    const updates = finalUpdates()
    expect(updates.n1).toMatchObject({ status: "SENT", emailMessageId: "a", sentAt: expect.any(Date) })
    expect(updates.n2).toMatchObject({ status: "FAILED", emailError: "Invalid `to` field", sentAt: null })
    expect(updates.n3).toMatchObject({ status: "SENT", emailMessageId: "c" })
  })

  it("leaves scheduled sends pending for the cron", async () => {
    db.user.findMany.mockResolvedValue([member("u1"), member("u2")])
    const scheduledFor = new Date("2026-10-15T15:00:00Z")

    await sendBulkNotification({ userIds: ["u1", "u2"], type: "CUSTOM", title: "Hi", body: "Hi", channels: ["IN_APP", "EMAIL"], scheduledFor })

    const rows = db.notification.createManyAndReturn.mock.calls[0][0].data
    expect(rows.every((r: { status: string; sentAt: unknown }) => r.status === "PENDING" && r.sentAt === null)).toBe(true)
    expect(email.sendEmail).not.toHaveBeenCalled()
    expect(email.sendBatchEmails).not.toHaveBeenCalled()
  })

  it("links emails to the full site address", async () => {
    db.user.findMany.mockResolvedValue([member("u1")])

    await sendBulkNotification({ userIds: ["u1"], type: "CUSTOM", title: "Hi", body: "Hi", actionUrl: "/events/gm1", channels: ["EMAIL"] })

    const [sent] = email.sendEmail.mock.calls[0]
    expect(sent.to).toBe("u1@utexas.edu")
    expect(sent.html).toContain("https://www.longhornsimracing.org/events/gm1")
  })

  it("does nothing when nobody is left to notify", async () => {
    db.user.findMany.mockResolvedValue([member("u1", { marketingOptIn: false })])

    await expect(
      sendBulkNotification({ userIds: ["u1"], type: "CUSTOM", title: "Hi", body: "Hi", channels: ["EMAIL"] })
    ).resolves.toEqual({ inApp: 0, emails: 0 })
    expect(db.notification.createManyAndReturn).not.toHaveBeenCalled()
  })
})

describe("processScheduledNotifications", () => {
  const due = (id: string, channel: "EMAIL" | "IN_APP") => ({
    id,
    channel,
    type: "CUSTOM",
    title: "Hi",
    body: "Hi",
    actionUrl: null,
    metadata: null,
    user: { id: `user-${id}`, email: `user-${id}@utexas.edu` },
  })

  it("delivers only the rows it claimed, emails in one batch", async () => {
    db.notification.findMany.mockResolvedValue([due("a", "EMAIL"), due("b", "EMAIL"), due("c", "IN_APP"), due("d", "EMAIL")])
    // "b" was claimed by another path first
    db.notification.updateMany.mockImplementation(async ({ where }: { where: { id: string } }) => ({ count: where.id === "b" ? 0 : 1 }))

    await expect(processScheduledNotifications()).resolves.toBe(3)

    expect(email.sendBatchEmails).toHaveBeenCalledTimes(1)
    expect(email.sendBatchEmails.mock.calls[0][0].map((e: { to: string }) => e.to)).toEqual(["user-a@utexas.edu", "user-d@utexas.edu"])
    expect(Object.keys(finalUpdates()).sort()).toEqual(["a", "d"])
  })

  it("claims with a conditional update so two paths never send the same row", async () => {
    db.notification.findMany.mockResolvedValue([due("a", "EMAIL")])
    await processScheduledNotifications()
    expect(db.notification.updateMany).toHaveBeenCalledWith({
      where: { id: "a", status: "PENDING" },
      data: { status: "SENT", sentAt: null },
    })
  })
})

describe("retryNotification", () => {
  it("resends a failed notification", async () => {
    db.notification.findUnique.mockResolvedValue({
      id: "f1",
      status: "FAILED",
      channel: "EMAIL",
      type: "CUSTOM",
      title: "Hi",
      body: "Hi",
      actionUrl: null,
      metadata: null,
      user: { id: "u1", email: "u1@utexas.edu" },
    })

    await retryNotification("f1")

    expect(db.notification.update).toHaveBeenCalledWith({ where: { id: "f1" }, data: { status: "PENDING", emailError: null } })
    expect(email.sendEmail).toHaveBeenCalledTimes(1)
    expect(finalUpdates().f1).toMatchObject({ status: "SENT", emailMessageId: "msg_single" })
  })

  it("leaves anything that didn't fail alone", async () => {
    db.notification.findUnique.mockResolvedValue({ id: "s1", status: "SENT" })
    await retryNotification("s1")
    expect(db.notification.update).not.toHaveBeenCalled()
    expect(email.sendEmail).not.toHaveBeenCalled()
  })
})

describe("getEmailUsage", () => {
  it("counts emails Resend accepted in the last 24 hours against the free plan's 100", async () => {
    vi.stubEnv("RESEND_DAILY_LIMIT", "")
    db.notification.count.mockResolvedValue(37)

    await expect(getEmailUsage()).resolves.toEqual({ sentLast24h: 37, dailyLimit: 100 })
    expect(db.notification.count.mock.calls[0][0].where).toMatchObject({ channel: "EMAIL", emailMessageId: { not: null } })
  })

  it("uses RESEND_DAILY_LIMIT when the plan changes", async () => {
    vi.stubEnv("RESEND_DAILY_LIMIT", "3000")
    db.notification.count.mockResolvedValue(0)
    await expect(getEmailUsage()).resolves.toMatchObject({ dailyLimit: 3000 })
  })
})
