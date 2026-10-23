import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  user: { findMany: vi.fn() },
  event: { findUnique: vi.fn() },
  eventRegistration: { findMany: vi.fn() },
  eventAttendance: { findMany: vi.fn() },
  notification: { count: vi.fn() },
}))
const notifications = vi.hoisted(() => ({ countEmailRecipients: vi.fn(), countScheduledAnnouncementEmails: vi.fn(), getEmailUsage: vi.fn(), sendBulkNotification: vi.fn(), TRANSACTIONAL_HEADROOM: 10 }))
const seasons = vi.hoisted(() => ({ resolveLeagueSeason: vi.fn(), DEFAULT_LEAGUE: "lone-star-cup" }))
const entries = vi.hoisted(() => ({ listSeasonEntrants: vi.fn() }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePaths: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/notification.service", () => notifications)
vi.mock("@/server/jack/tools/seasons", () => seasons)
vi.mock("@/server/services/league-entry.service", () => entries)
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/cache/revalidate-public", () => cache)

import { ProposalInputError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { notificationSendKind, notificationSendSchema, resolveAudience, type NotificationSend } from "./notification-send"

const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const meta = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" }
const applyCtx = (before: unknown, selectedRows?: string[]): ProposalApplyContext => ({ officer: { userId: "u2", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: meta, selectedRows })

const people = [
  { id: "a", displayName: "Ana Torres", handle: "ana-torres" },
  { id: "b", displayName: "Ben Ito", handle: "ben-ito" },
  { id: "c", displayName: "Cy Park", handle: "cy-park" },
]
const message = (p: Record<string, unknown>) =>
  notificationSendSchema.parse({ audience: { type: "event", eventId: "ev-1" }, channels: ["in_app", "email"], title: "GM 2 moved to 7 PM", body: "GM 2 starts at 7 PM now.\n\nSee you there!", ...p }) as NotificationSend

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-22T17:00:00Z"))
  db.user.findMany.mockResolvedValue(people)
  db.event.findUnique.mockResolvedValue({ id: "ev-1", title: "GM 2" })
  db.eventRegistration.findMany.mockResolvedValue(people.map((user) => ({ user })))
  db.eventAttendance.findMany.mockResolvedValue([{ user: people[0] }])
  db.notification.count.mockResolvedValue(0)
  notifications.countEmailRecipients.mockImplementation(async (ids: string[]) => ids.length - (ids.includes("c") ? 1 : 0))
  notifications.getEmailUsage.mockResolvedValue({ sentToday: 20, dailyLimit: 100 })
  notifications.countScheduledAnnouncementEmails.mockResolvedValue(0)
  notifications.sendBulkNotification.mockResolvedValue({ inApp: 3, emails: 2, emailsSent: 2, emailsFailed: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("notification.send's schema", () => {
  it("takes plain text only, and a link text only with a link", () => {
    expect(notificationSendSchema.safeParse({ audience: { type: "officers" }, channels: ["email"], title: "Hi", body: "<b>Hi</b>" }).success).toBe(false)
    expect(notificationSendSchema.safeParse({ audience: { type: "officers" }, channels: ["email"], title: "Hi <3", body: "Hi" }).success).toBe(false)
    expect(notificationSendSchema.safeParse({ audience: { type: "officers" }, channels: ["email"], title: "Hi", body: "Hi", linkText: "Go" }).success).toBe(false)
    expect(notificationSendSchema.safeParse({ audience: { type: "officers" }, channels: [], title: "Hi", body: "Hi" }).success).toBe(false)
    expect(notificationSendKind).toMatchObject({ kind: "notification.send", tool: "propose_message", permission: "officer", destructive: true })
  })
})

describe("resolving the audience", () => {
  it("finds an event's registered, waitlisted or checked-in people", async () => {
    expect(await resolveAudience({ type: "event", eventId: "ev-1", who: "registered" })).toEqual({ recipients: people, label: "people registered for “GM 2”", key: "event:ev-1:registered" })
    expect(db.eventRegistration.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { eventId: "ev-1", status: "REGISTERED", user: { status: { not: "deleted" } } } }))
    await resolveAudience({ type: "event", eventId: "ev-1", who: "waitlisted" })
    expect(db.eventRegistration.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "WAITLISTED" }) }))
    expect(await resolveAudience({ type: "event", eventId: "ev-1", who: "checked_in" })).toMatchObject({ recipients: [people[0]], label: "people checked in at “GM 2”" })
    db.event.findUnique.mockResolvedValue(null)
    await expect(resolveAudience({ type: "event", eventId: "nope", who: "registered" })).rejects.toBeInstanceOf(ProposalInputError)
  })

  it("finds every active member, the officers, or members by handle", async () => {
    expect(await resolveAudience({ type: "all_members" })).toMatchObject({ label: "every active member", key: "all_members" })
    expect(db.user.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { status: "active" } }))
    await resolveAudience({ type: "officers" })
    expect(db.user.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { status: { not: "deleted" }, roles: { some: { role: { key: { in: ["officer", "admin"] } } } } } }))
    db.user.findMany.mockResolvedValue([people[1]])
    expect(await resolveAudience({ type: "members", handles: ["@Ben-Ito"] })).toEqual({ recipients: [people[1]], label: "Ben Ito", key: "members:ben-ito" })
    await expect(resolveAudience({ type: "members", handles: ["ben-ito", "ghost"] })).rejects.toThrow("No member has the handle @ghost.")
  })

  it("finds a season's LSC drivers with an entry, or everyone who applied", async () => {
    seasons.resolveLeagueSeason.mockResolvedValue({ ok: true, season: { id: "s3", name: "LSC Season 3" } })
    entries.listSeasonEntrants.mockResolvedValue({
      entrants: [
        { status: "paid", application: {}, user: people[0] },
        { status: "manual", application: null, user: people[1] },
        { status: "none", application: {}, user: people[2] },
      ],
    })
    expect(await resolveAudience({ type: "lsc_drivers", who: "entered" })).toEqual({ recipients: [people[0], people[1]], label: "LSC Season 3 drivers with an entry", key: "lsc:s3:entered" })
    expect(await resolveAudience({ type: "lsc_drivers", who: "applied" })).toMatchObject({ recipients: [people[0], people[2]], label: "LSC Season 3 drivers who filled out the entry form" })
    seasons.resolveLeagueSeason.mockResolvedValue({ ok: false, error: 'No Lone Star Cup season "s9".' })
    await expect(resolveAudience({ type: "lsc_drivers", season: "s9", who: "entered" })).rejects.toThrow('No Lone Star Cup season "s9".')
  })
})

describe("notification.send: prepare", () => {
  it("lists every recipient as a row, previews the message, and counts the emails", async () => {
    const prepared = await notificationSendKind.prepare(message({ link: "/events/gm-2", linkText: "Event page" }), ctx)
    expect(prepared.targetId).toBe("event:ev-1:registered")
    expect(prepared.before).toEqual({ recipients: ["a", "b", "c"], label: "people registered for “GM 2”", key: "event:ev-1:registered" })
    expect(prepared.view.title).toBe("Send “GM 2 moved to 7 PM” to people registered for “GM 2”")
    expect(prepared.view.summary).toBe(
      "Applying it sends “GM 2 moved to 7 PM” in the site's bell and by email to the 3 people checked below (people registered for “GM 2”), right away. 2 people get the email; the others have club emails turned off. It can't be unsent.",
    )
    expect(prepared.view.rows).toEqual([
      { id: "a", label: "Ana Torres", detail: "@ana-torres" },
      { id: "b", label: "Ben Ito", detail: "@ben-ito" },
      { id: "c", label: "Cy Park", detail: "@cy-park" },
    ])
    expect(prepared.view.preview).toEqual({
      label: "The message",
      title: "GM 2 moved to 7 PM",
      blocks: [
        { t: "p", c: [{ t: "text", v: "GM 2 starts at 7 PM now." }] },
        { t: "p", c: [{ t: "text", v: "See you there!" }] },
        { t: "p", c: [{ t: "link", url: "/events/gm-2", c: [{ t: "text", v: "Event page" }] }] },
      ],
    })
    expect(prepared.view.links).toEqual([
      { title: "The message's page", url: "/events/gm-2" },
      { title: "Notifications", url: "/admin/notifications" },
    ])
  })

  it("warns when today's emails won't cover it, and refuses more than a day can send", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 89, dailyLimit: 100 })
    const tight = await notificationSendKind.prepare(message({}), ctx)
    expect(tight.view.summary).toContain("Only 1 of today's 100 emails are left (89 sent today, 10 kept for confirmations and receipts), so applying it today is refused unless fewer people are checked.")
    notifications.countEmailRecipients.mockResolvedValue(95)
    await expect(notificationSendKind.prepare(message({}), ctx)).rejects.toThrow("This would send 95 emails, more than the 90 a day an announcement can use")
    // In the bell only: no email to count
    await expect(notificationSendKind.prepare(message({ channels: ["in_app"] }), ctx)).resolves.toBeTruthy()
  })

  it("holds a scheduled send to the day's maximum too, and counts what that day already has", async () => {
    // Tomorrow, 9 AM CT: today's emails don't count against it
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 89, dailyLimit: 100 })
    const tomorrow = await notificationSendKind.prepare(message({ sendAt: "2026-10-23T09:00" }), ctx)
    expect(tomorrow.view.summary).toContain(", at Fri Oct 23, 9:00 AM CT.")
    expect(tomorrow.view.summary).toContain("If other emails use up that day's limit before it goes out, the ones over it aren't sent; they show as failed on Notifications.")
    expect(notifications.countScheduledAnnouncementEmails).toHaveBeenCalledWith(new Date("2026-10-23T14:00:00Z"))
    // The day's maximum is the same whatever day it goes out
    notifications.countEmailRecipients.mockResolvedValue(95)
    await expect(notificationSendKind.prepare(message({ sendAt: "2026-10-23T09:00" }), ctx)).rejects.toThrow("This would send 95 emails, more than the 90 a day an announcement can use")
    // Other announcements already scheduled for that day
    notifications.countEmailRecipients.mockResolvedValue(40)
    notifications.countScheduledAnnouncementEmails.mockResolvedValue(60)
    expect((await notificationSendKind.prepare(message({ sendAt: "2026-10-23T09:00" }), ctx)).view.summary).toContain(
      "Only 30 of the 90 announcement emails for that day are left (60 already scheduled for it), so applying it is refused unless fewer people are checked. The limit resets",
    )
    // Later today: what's sent today counts too
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 50, dailyLimit: 100 })
    notifications.countScheduledAnnouncementEmails.mockResolvedValue(5)
    expect((await notificationSendKind.prepare(message({ sendAt: "2026-10-22T17:00" }), ctx)).view.summary).toContain("Only 35 of the 90 announcement emails for that day are left (50 sent today and 5 already scheduled for it)")
    // A plan without a daily limit
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 5000, dailyLimit: null })
    notifications.countEmailRecipients.mockResolvedValue(1500)
    expect((await notificationSendKind.prepare(message({ sendAt: "2026-10-23T09:00" }), ctx)).view.summary).not.toContain("limit")
  })

  it("refuses bad links, past times and empty audiences", async () => {
    await expect(notificationSendKind.prepare(message({ link: "javascript:alert(1)" }), ctx)).rejects.toThrow(/isn't a page of this site/)
    await expect(notificationSendKind.prepare(message({ link: "//evil.example/x" }), ctx)).rejects.toThrow(/isn't a page of this site/)
    await expect(notificationSendKind.prepare(message({ sendAt: "2026-10-21T09:00" }), ctx)).rejects.toThrow(/has passed/)
    db.eventRegistration.findMany.mockResolvedValue([])
    await expect(notificationSendKind.prepare(message({}), ctx)).rejects.toThrow("Nobody is in that audience (people registered for “GM 2”)")
  })

  it("shows an outside link with its host", async () => {
    const prepared = await notificationSendKind.prepare(message({ link: "https://www.twitch.tv/lsr" }), ctx)
    expect(prepared.view.links?.[0]).toEqual({ title: "The message's link", url: "https://www.twitch.tv/lsr" })
  })
})

describe("notification.send: apply", () => {
  const before = { recipients: ["a", "b", "c"], label: "people registered for “GM 2”" }

  it("sends to the ticked recipients through the notification service, with one audit entry", async () => {
    const result = await notificationSendKind.apply(message({ link: "/events/gm-2", linkText: "Event page" }), applyCtx(before, ["a", "c"]))
    expect(notifications.sendBulkNotification).toHaveBeenCalledWith({
      userIds: ["a", "c"],
      type: "CUSTOM",
      title: "GM 2 moved to 7 PM",
      body: "GM 2 starts at 7 PM now.\n\nSee you there!",
      actionUrl: "/events/gm-2",
      channels: ["IN_APP", "EMAIL"],
      scheduledFor: undefined,
      metadata: { via: "jack", proposalId: "prop-1", actionText: "Event page" },
    })
    expect(audit.createAuditLog).toHaveBeenCalledTimes(1)
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "u2",
        actionType: "CREATE",
        entityType: "NOTIFICATION",
        entityId: "multi",
        metadata: expect.objectContaining({ ...meta, recipientCount: 2, userIds: ["a", "c"], actionUrl: "/events/gm-2" }),
      }),
    )
    expect(cache.revalidatePaths).toHaveBeenCalledWith(["/admin/notifications"])
    expect(result).toMatchObject({ summary: "Sent “GM 2 moved to 7 PM” to 2 people: 2 emails sent.", appliedRows: ["a", "c"] })
  })

  it("never sends twice for one proposal", async () => {
    db.notification.count.mockResolvedValue(4)
    const result = await notificationSendKind.apply(message({}), applyCtx(before))
    expect(db.notification.count).toHaveBeenCalledWith({ where: { metadata: { path: ["proposalId"], equals: "prop-1" } } })
    expect(notifications.sendBulkNotification).not.toHaveBeenCalled()
    expect(result.summary).toBe("Already sent for this proposal (4 notifications); nothing was sent again.")
  })

  it("checks today's emails again for the people ticked, and schedules when asked", async () => {
    notifications.getEmailUsage.mockResolvedValue({ sentToday: 89, dailyLimit: 100 })
    await expect(notificationSendKind.apply(message({}), applyCtx(before))).rejects.toThrow("This would send 2 emails, but only 1 of today's 100 are left")
    expect(notifications.sendBulkNotification).not.toHaveBeenCalled()
    await notificationSendKind.apply(message({}), applyCtx(before, ["a"]))
    expect(notifications.sendBulkNotification).toHaveBeenLastCalledWith(expect.objectContaining({ userIds: ["a"] }))
    const scheduled = await notificationSendKind.apply(message({ sendAt: "2026-10-23T09:00" }), applyCtx(before))
    expect(notifications.sendBulkNotification).toHaveBeenLastCalledWith(expect.objectContaining({ scheduledFor: new Date("2026-10-23T14:00:00Z") }))
    expect(scheduled.summary).toBe("Scheduled “GM 2 moved to 7 PM” for 3 people, Fri Oct 23, 9:00 AM CT.")
  })

  it("refuses a scheduled send over the day's maximum, or over what that day has left", async () => {
    notifications.countEmailRecipients.mockResolvedValue(95)
    await expect(notificationSendKind.apply(message({ sendAt: "2026-10-23T09:00" }), applyCtx(before))).rejects.toThrow("This would send 95 emails, more than the 90 a day an announcement can use")
    notifications.countEmailRecipients.mockResolvedValue(40)
    notifications.countScheduledAnnouncementEmails.mockResolvedValue(60)
    await expect(notificationSendKind.apply(message({ sendAt: "2026-10-23T09:00" }), applyCtx(before))).rejects.toThrow(
      "This would send 40 emails at Fri Oct 23, 9:00 AM CT, but only 30 of the 90 announcement emails for that day are left (60 already scheduled for it).",
    )
    expect(notifications.sendBulkNotification).not.toHaveBeenCalled()
    // In the bell only: no email budget
    await notificationSendKind.apply(message({ sendAt: "2026-10-23T09:00", channels: ["in_app"] }), applyCtx(before))
    expect(notifications.sendBulkNotification).toHaveBeenCalledTimes(1)
  })
})

describe("notification.send: staleness", () => {
  const before = { recipients: ["a", "b", "c"], label: "people registered for “GM 2”", key: "event:ev-1:registered" }
  const dee = { id: "d", displayName: "Dee Lu", handle: "dee-lu" }

  it("goes stale once its send time has passed", async () => {
    const p = message({ sendAt: "2026-10-23T09:00" })
    expect(await notificationSendKind.checkStale(p, before)).toBeNull()
    vi.setSystemTime(new Date("2026-10-24T00:00:00Z"))
    expect(await notificationSendKind.checkStale(p, before)).toMatch(/Its send time \(Fri Oct 23, 9:00 AM CT\) has passed/)
  })

  it("goes stale when someone left or joined its audience since it was proposed", async () => {
    const p = message({})
    expect(await notificationSendKind.checkStale(p, before)).toBeNull()
    // Cy unregistered: the card still lists them
    db.eventRegistration.findMany.mockResolvedValue([people[0], people[1]].map((user) => ({ user })))
    expect(await notificationSendKind.checkStale(p, before)).toBe(
      "Its audience (people registered for “GM 2”) changed since this was proposed: 1 person on the card left. Ask Jack to propose it again, so the card lists who gets it now.",
    )
    // Dee registered: the card doesn't list them
    db.eventRegistration.findMany.mockResolvedValue([...people, dee].map((user) => ({ user })))
    expect(await notificationSendKind.checkStale(p, before)).toMatch(/changed since this was proposed: 1 person joined\./)
    db.eventRegistration.findMany.mockResolvedValue([people[0], dee].map((user) => ({ user })))
    expect(await notificationSendKind.checkStale(p, before)).toMatch(/changed since this was proposed: 2 people on the card left and 1 person joined\./)
    // Every active member: someone signed up since
    db.user.findMany.mockResolvedValue([...people, dee])
    expect(await notificationSendKind.checkStale(message({ audience: { type: "all_members" } }), { recipients: ["a", "b", "c"], label: "every active member", key: "all_members" })).toMatch(
      /^Its audience \(every active member\) changed since this was proposed: 1 person joined\./,
    )
  })

  it("goes stale when its event was deleted, or its audience now means another season", async () => {
    db.event.findUnique.mockResolvedValue(null)
    expect(await notificationSendKind.checkStale(message({}), before)).toBe("The event was deleted.")
    // "The open season" moved on
    const lsc = message({ audience: { type: "lsc_drivers" } })
    const lscBefore = { recipients: ["a"], label: "LSC Season 3 drivers with an entry", key: "lsc:s3:entered" }
    seasons.resolveLeagueSeason.mockResolvedValue({ ok: true, season: { id: "s4", name: "LSC Season 4" } })
    entries.listSeasonEntrants.mockResolvedValue({ entrants: [{ status: "paid", application: {}, user: people[0] }] })
    db.user.findMany.mockResolvedValue([{ id: "a" }])
    expect(await notificationSendKind.checkStale(lsc, lscBefore)).toBe("It was proposed for LSC Season 3 drivers with an entry, which now means LSC Season 4 drivers with an entry. Ask Jack to propose it again.")
    seasons.resolveLeagueSeason.mockResolvedValue({ ok: false, error: "Lone Star Cup has no seasons yet." })
    expect(await notificationSendKind.checkStale(lsc, lscBefore)).toBe("Its audience (LSC Season 3 drivers with an entry) can't be worked out anymore: Lone Star Cup has no seasons yet.")
  })

  it("keeps a list of handles as proposed, and needs its saved list otherwise", async () => {
    const handles = message({ audience: { type: "members", handles: ["ana-torres"] } })
    expect(await notificationSendKind.checkStale(handles, { recipients: ["a"], label: "Ana Torres", key: "members:ana-torres" })).toBeNull()
    expect(db.user.findMany).not.toHaveBeenCalled()
    expect(await notificationSendKind.checkStale(message({}), null)).toMatch(/list of recipients is missing/)
  })
})
