import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  delivery: { deliveryFor: vi.fn(), bouncedRecipients: vi.fn(), emailsTo: vi.fn(), emailTimeline: vi.fn(), subjectsFor: vi.fn() },
  prisma: {
    emailEvent: { findFirst: vi.fn() },
    notification: { findMany: vi.fn(), findUnique: vi.fn() },
    applicationEmail: { findMany: vi.fn(), findUnique: vi.fn() },
    user: { findFirst: vi.fn() },
  },
}))
vi.mock("@/server/db", () => ({ prisma: mocks.prisma }))
vi.mock("@/server/connectors/resend/connector", () => ({ resendConnector: { status: mocks.status } }))
vi.mock("@/server/connectors/resend/delivery", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/connectors/resend/delivery")>()), ...mocks.delivery }))

import { PRIVATE_RECRUITING_EMAIL } from "@/server/connectors/resend/delivery"
import { emailDeliveryTool } from "./email-delivery"

const run = (input: Record<string, unknown> = {}) => emailDeliveryTool.run(emailDeliveryTool.input.parse(input), { roomId: "r1", actor: { userId: "u1", displayName: "Gray" } })
const sentAt = new Date("2026-10-20T23:00:00Z") // Oct 20, 6 PM in Chicago

beforeEach(() => {
  mocks.status.mockResolvedValue({ state: "connected", lastSyncAt: new Date().toISOString(), missingEnv: [], missingSettings: [] })
  mocks.prisma.notification.findMany.mockResolvedValue([
    { title: "GM 2 is tonight", type: "EVENT_REMINDER", status: "SENT", sentAt, createdAt: sentAt, emailMessageId: "e1" },
    { title: "GM 2 is tonight", type: "EVENT_REMINDER", status: "SENT", sentAt, createdAt: sentAt, emailMessageId: "e2" },
    { title: "GM 2 is tonight", type: "EVENT_REMINDER", status: "SENT", sentAt, createdAt: sentAt, emailMessageId: "e3" },
    { title: "GM 2 is tonight", type: "EVENT_REMINDER", status: "FAILED", sentAt: null, createdAt: sentAt, emailMessageId: null },
  ])
  mocks.prisma.applicationEmail.findMany.mockResolvedValue([])
  mocks.delivery.deliveryFor.mockResolvedValue(
    new Map([
      ["e1", { status: "delivered", at: sentAt, reason: null }],
      ["e2", { status: "bounced", at: sentAt, reason: "Permanent: No such user" }],
    ]),
  )
})

describe("email_delivery", () => {
  it("is deferred, read only and named for its subject", () => {
    expect(emailDeliveryTool).toMatchObject({ name: "email_delivery", deferred: true })
    expect(emailDeliveryTool.writes).toBeFalsy()
  })

  it("groups a send's emails by outcome, on the Central day it went out", async () => {
    const data = JSON.parse((await run({ match: "GM 2" })).forModel)
    expect(data.list).toEqual([{ email: "GM 2 is tonight", type: "EVENT_REMINDER", day: "2026-10-20", emails: 4, outcome: "delivered 1, bounced 1, no report yet 1, never sent 1" }])
    expect(mocks.prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ channel: "EMAIL", title: { contains: "GM 2", mode: "insensitive" } }) }))
  })

  it("leaves recruiting mail to officer and admin applicants out of the counts", async () => {
    await run()
    expect(mocks.prisma.applicationEmail.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ application: { user: { roles: { none: { role: { key: { in: ["officer", "admin"] } } } } } } }) }))
  })

  it("looks up one recipient only by the address or handle given, hiding officer applicants' recruiting mail", async () => {
    mocks.prisma.user.findFirst.mockResolvedValue({ email: "Driver@Example.com", displayName: "Test Driver" })
    mocks.delivery.emailsTo.mockResolvedValue([{ resendId: "e9", status: "delivered", at: sentAt, reason: null, sentAt, subject: PRIVATE_RECRUITING_EMAIL }])
    const data = JSON.parse((await run({ view: "recipient", recipient: "@test-driver" })).forModel)
    expect(mocks.delivery.emailsTo).toHaveBeenCalledWith("driver@example.com", expect.any(Date), 25, { hideOfficerApplicants: true })
    expect(data.list[0]).toMatchObject({ what: PRIVATE_RECRUITING_EMAIL.subject, status: "Delivered" })
    expect(await run({ view: "recipient" })).toMatchObject({ isError: true })
  })

  it("shows one email's events, or says it never reached Resend", async () => {
    mocks.prisma.notification.findUnique.mockResolvedValue({ emailMessageId: "e2", status: "SENT", emailError: null, title: "GM 2 is tonight" })
    mocks.prisma.applicationEmail.findUnique.mockResolvedValue(null)
    mocks.delivery.emailTimeline.mockResolvedValue([
      { type: "email.sent", occurredAt: sentAt, detail: null, recipient: "a@example.com" },
      { type: "email.bounced", occurredAt: sentAt, detail: { bounceType: "Permanent", message: "No such user" }, recipient: "a@example.com" },
    ])
    mocks.delivery.subjectsFor.mockResolvedValue(new Map([["e2", { kind: "notification", subject: "GM 2 is tonight", detail: null, link: null }]]))
    const data = JSON.parse((await run({ view: "email", id: "n-2" })).forModel)
    expect(data.email).toMatchObject({ status: "Bounced", what: "GM 2 is tonight" })
    expect(data.events[1]).toMatchObject({ type: "bounced", reason: "Permanent: No such user" })

    mocks.prisma.notification.findUnique.mockResolvedValue({ emailMessageId: null, status: "FAILED", emailError: "Daily email limit reached", title: "x" })
    expect(JSON.parse((await run({ view: "email", id: "n-3" })).forModel).email).toMatchObject({ sent: false, error: "Daily email limit reached" })
  })

  it("never shows a private recruiting email's events", async () => {
    mocks.prisma.notification.findUnique.mockResolvedValue(null)
    mocks.prisma.applicationEmail.findUnique.mockResolvedValue({ resendMessageId: "r1", status: "SENT", error: null, application: { user: { roles: [{ role: { key: "admin" } }] } } })
    const result = await run({ view: "email", id: "ae-1" })
    expect(result.forModel).toContain("private")
    expect(mocks.delivery.emailTimeline).not.toHaveBeenCalled()
  })

  it("lists bounces", async () => {
    mocks.delivery.bouncedRecipients.mockResolvedValue({ total: 1, rows: [{ recipient: "gone@example.com", failed: 2, lastStatus: "bounced", lastAt: sentAt, reason: "No such user", deliveredSince: false, lastEmail: null, member: { id: "u9", displayName: "Test Member" } }] })
    const data = JSON.parse((await run({ view: "bounces", days: 30 })).forModel)
    expect(data.bounced).toEqual([{ recipient: "gone@example.com", member: "Test Member", status: "Bounced", last: expect.stringMatching(/^Tue 2026-10-20 18:00 CT$/), emailsNotDelivered: 2, reason: "No such user" }])
    expect(mocks.delivery.bouncedRecipients).toHaveBeenCalledWith(expect.any(Date), 25, { hideOfficerApplicants: true })
  })

  it("says it isn't connected when it's not set up and no event ever came", async () => {
    mocks.status.mockResolvedValue({ state: "not_configured", lastSyncAt: null, missingEnv: ["RESEND_WEBHOOK_SECRET"], missingSettings: [] })
    mocks.prisma.emailEvent.findFirst.mockResolvedValue(null)
    expect((await run()).forModel).toMatch(/not set up yet \(missing: RESEND_WEBHOOK_SECRET\)/)
  })
})
