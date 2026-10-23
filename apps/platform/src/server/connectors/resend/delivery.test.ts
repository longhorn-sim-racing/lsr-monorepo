import { beforeEach, describe, expect, it, vi } from "vitest"

type Row = { resendId: string; recipient: string; type: string; occurredAt: Date; detail: unknown }
const db = vi.hoisted(() => ({ events: [] as Row[], users: [] as { id: string; displayName: string; email: string }[], recruiting: [] as unknown[] }))

/** Enough of Prisma's where for these reads: in-lists, type lists and a date floor */
function matches(row: Row, where: Record<string, unknown>) {
  const inList = (value: string, filter: unknown) => !filter || (filter as { in: string[] }).in.includes(value)
  const since = (where.occurredAt as { gte?: Date } | undefined)?.gte
  const recipient = where.recipient as unknown
  return (
    inList(row.resendId, where.resendId) &&
    inList(row.type, where.type) &&
    (typeof recipient === "string" ? row.recipient === recipient : inList(row.recipient, recipient)) &&
    (!since || row.occurredAt >= since)
  )
}

vi.mock("@/server/db", () => ({
  prisma: {
    emailEvent: { findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => db.events.filter((row) => matches(row, where))) },
    user: { findMany: vi.fn(async () => db.users) },
    notification: { findMany: vi.fn(async () => [{ emailMessageId: "e-gm2", title: "GM 2 is tonight", type: "EVENT_REMINDER" }]) },
    applicationEmail: { findMany: vi.fn(async () => db.recruiting) },
  },
}))

import { bouncedRecipients, emailsTo, eventReason, PRIVATE_RECRUITING_EMAIL, subjectsFor, summarizeEvents } from "./delivery"

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 18, minutes))
const event = (resendId: string, recipient: string, type: string, minutes: number, detail: unknown = null): Row => ({ resendId, recipient, type, occurredAt: at(minutes), detail })

beforeEach(() => {
  db.users = [{ id: "u1", displayName: "Test Member", email: "Member@Example.com" }]
  db.recruiting = []
  db.events = [
    // A bounced reminder, then a later email to the same address that arrived
    event("e-gm2", "member@example.com", "email.sent", 0),
    event("e-gm2", "member@example.com", "email.bounced", 1, { bounceType: "Permanent", subType: "General", message: "No such user" }),
    event("e-later", "member@example.com", "email.sent", 30),
    event("e-later", "member@example.com", "email.delivered", 31),
    // A delayed email that then arrived isn't a bounce
    event("e-ok", "other@example.com", "email.delivery_delayed", 2),
    event("e-ok", "other@example.com", "email.delivered", 9),
    // A complaint, arriving before its delivered event
    event("e-spam", "spam@example.com", "email.complained", 5),
    event("e-spam", "spam@example.com", "email.delivered", 4),
  ]
})

describe("summarizeEvents", () => {
  it("gives each email its status from all its events, its reason and its time span", () => {
    const delivery = summarizeEvents(db.events)
    expect(delivery.get("e-gm2")).toMatchObject({ status: "bounced", reason: "Permanent: No such user", firstAt: at(0), at: at(1), recipient: "member@example.com" })
    expect(delivery.get("e-ok")).toMatchObject({ status: "delivered" })
    expect(delivery.get("e-spam")).toMatchObject({ status: "complained" })
  })
})

describe("eventReason", () => {
  it("reads a bounce, a failure and a suppression", () => {
    expect(eventReason({ bounceType: "Transient", subType: "MailboxFull", message: "Mailbox full" })).toBe("Transient MailboxFull: Mailbox full")
    expect(eventReason({ reason: "reached_daily_quota" })).toBe("reached daily quota")
    expect(eventReason(null)).toBeNull()
  })
})

describe("bouncedRecipients", () => {
  it("lists addresses whose mail didn't arrive, newest first, with the member and whether later mail got through", async () => {
    const { rows, total } = await bouncedRecipients(at(-60))
    expect(total).toBe(2)
    expect(rows.map((r) => r.recipient)).toEqual(["spam@example.com", "member@example.com"])
    expect(rows[1]).toMatchObject({ failed: 1, lastStatus: "bounced", reason: "Permanent: No such user", deliveredSince: true, member: { id: "u1", displayName: "Test Member" }, lastEmail: { subject: "GM 2 is tonight" } })
    expect(rows[0]).toMatchObject({ lastStatus: "complained", deliveredSince: false, member: null })
  })
})

describe("emailsTo", () => {
  it("lists one address's emails newest first with their status", async () => {
    const emails = await emailsTo("Member@example.com", at(-60))
    expect(emails.map((e) => [e.resendId, e.status])).toEqual([
      ["e-later", "delivered"],
      ["e-gm2", "bounced"],
    ])
  })
})

describe("subjectsFor", () => {
  it("hides a recruiting email's subject from Jack when the applicant is an officer or admin", async () => {
    db.recruiting = [
      { resendMessageId: "r-officer", subject: "Your application: accepted", template: "ACCEPTED", applicationId: "a1", application: { user: { roles: [{ role: { key: "officer" } }] } } },
      { resendMessageId: "r-member", subject: "We got your application", template: "RECEIVED", applicationId: "a2", application: { user: { roles: [] } } },
    ]
    const hidden = await subjectsFor(["r-officer", "r-member"], { hideOfficerApplicants: true })
    expect(hidden.get("r-officer")).toEqual(PRIVATE_RECRUITING_EMAIL)
    expect(hidden.get("r-member")).toMatchObject({ subject: "We got your application", link: "/admin/recruiting/a2" })
    // The console shows officers everything
    expect((await subjectsFor(["r-officer"])).get("r-officer")).toMatchObject({ subject: "Your application: accepted" })
  })
})
