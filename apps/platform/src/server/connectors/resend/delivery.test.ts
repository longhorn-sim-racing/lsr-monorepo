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

/** What deliveryCounts' SQL does, over the fake rows: each email with an event since the date gets its strongest event's rank (the CASE's order), counted per rank */
function countByRank(values: unknown[]) {
  const types = values.slice(0, -1) as string[]
  const since = values[values.length - 1] as Date
  const emails = new Set(db.events.filter((e) => e.occurredAt >= since).map((e) => e.resendId))
  const ranks = new Map<string, number>()
  for (const e of db.events) {
    const rank = types.indexOf(e.type)
    if (emails.has(e.resendId) && rank >= 0) ranks.set(e.resendId, Math.min(ranks.get(e.resendId) ?? rank, rank))
  }
  const counts = new Map<number, number>()
  for (const rank of ranks.values()) counts.set(rank, (counts.get(rank) ?? 0) + 1)
  return [...counts].map(([rank, emails]) => ({ rank, emails }))
}

vi.mock("@/server/db", () => ({
  prisma: {
    $queryRaw: vi.fn(async (query: { values: unknown[] }) => countByRank(query.values)),
    emailEvent: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => db.events.filter((row) => matches(row, where))),
      groupBy: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...new Set(db.events.filter((row) => matches(row, { type: where.type, occurredAt: where.occurredAt }) && row.recipient !== "").map((row) => row.recipient))].map((recipient) => ({ recipient })),
      ),
    },
    user: { findMany: vi.fn(async () => db.users) },
    notification: { findMany: vi.fn(async () => [{ emailMessageId: "e-gm2", title: "GM 2 is tonight", type: "EVENT_REMINDER" }]) },
    applicationEmail: { findMany: vi.fn(async () => db.recruiting) },
  },
}))

import { DELIVERY_RANK } from "@/lib/email-delivery"
import { prisma } from "@/server/db"
import { bouncedRecipientCount, bouncedRecipients, deliveryCounts, emailsTo, eventReason, PRIVATE_RECRUITING_EMAIL, subjectsFor, summarizeEvents } from "./delivery"

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

describe("bouncedRecipientCount", () => {
  it("counts the addresses the bounce list shows, without loading it", async () => {
    db.events.push(event("e-blank", "", "email.failed", 7, { reason: "reached_daily_quota" }))
    expect(await bouncedRecipientCount(at(-60))).toBe((await bouncedRecipients(at(-60))).total)
    expect(await bouncedRecipientCount(at(-60))).toBe(2)
    expect(await bouncedRecipientCount(at(3))).toBe(1)
  })
})

describe("deliveryCounts", () => {
  it("counts each email once, by its strongest event, as summarizeEvents does", async () => {
    const { emails, byStatus } = await deliveryCounts(at(-60))
    expect(emails).toBe(4)
    expect(byStatus).toEqual({ complained: 1, bounced: 1, failed: 0, suppressed: 0, clicked: 0, opened: 0, delivered: 2, delayed: 0, sent: 0 })
    const statuses = [...summarizeEvents(db.events).values()].map((d) => d.status)
    for (const [status, n] of Object.entries(byStatus)) expect(statuses.filter((s) => s === status)).toHaveLength(n)
  })

  it("counts an email by all its events, even ones from before the window", async () => {
    // e-gm2 bounced at minute 1; a late "delayed" event puts it in a window that starts after the bounce
    db.events.push(event("e-gm2", "member@example.com", "email.delivery_delayed", 40))
    expect((await deliveryCounts(at(35))).byStatus).toMatchObject({ bounced: 1 })
  })

  it("sends the event types as parameters in deliveryStatus's order, with only its own ranks in the SQL", async () => {
    await deliveryCounts(at(0))
    const query = vi.mocked(prisma.$queryRaw).mock.calls[0][0] as unknown as { text: string; values: unknown[] }
    expect(query.values).toEqual([...DELIVERY_RANK.map(([type]) => type), at(0)])
    expect(query.text).toContain("WHEN $1 THEN 0 WHEN $2 THEN 1")
    expect(query.text).toContain(`WHEN $${DELIVERY_RANK.length} THEN ${DELIVERY_RANK.length - 1} END`)
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
