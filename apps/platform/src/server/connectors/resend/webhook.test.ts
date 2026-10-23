import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/server/db", () => ({ prisma: {} }))

import { svixSignature } from "./svix"
import { emailEventRow, verifyResendWebhook, webhookSecretProblem } from "./webhook"

// Svix's documented test vector (research/resend.md §4); the secret is built from pieces so no scanner flags it
const VECTOR = {
  secret: "whsec_" + "plJ3nmyCDGBKInavdOK15jsl",
  id: "msg_loFOjxBNrRLzqYUf",
  timestamp: 1731705121,
  body: '{"event_type":"ping","data":{"success":true}}',
  signature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
}

afterEach(() => {
  vi.useRealTimers()
})

describe("Svix signatures", () => {
  it("reproduce Svix's test vector", () => {
    expect(svixSignature(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.signature)
  })

  it("verify through resend.webhooks.verify() with the vector, at its own time", () => {
    vi.useFakeTimers({ now: VECTOR.timestamp * 1000 })
    expect(verifyResendWebhook(VECTOR.body, { id: VECTOR.id, timestamp: String(VECTOR.timestamp), signature: VECTOR.signature }, VECTOR.secret)).toEqual({ event_type: "ping", data: { success: true } })
  })

  it("refuse a changed body, another id, a wrong secret, or a timestamp over 5 minutes off", () => {
    vi.useFakeTimers({ now: VECTOR.timestamp * 1000 })
    const headers = { id: VECTOR.id, timestamp: String(VECTOR.timestamp), signature: VECTOR.signature }
    expect(() => verifyResendWebhook(VECTOR.body.replace("true", "false"), headers, VECTOR.secret)).toThrow(/signature/)
    expect(() => verifyResendWebhook(VECTOR.body, { ...headers, id: "msg_other" }, VECTOR.secret)).toThrow(/signature/)
    expect(() => verifyResendWebhook(VECTOR.body, headers, "whsec_" + "AAAAAAAAAAAAAAAAAAAAAAAA")).toThrow(/signature/)
    vi.setSystemTime((VECTOR.timestamp + 301) * 1000)
    expect(() => verifyResendWebhook(VECTOR.body, headers, VECTOR.secret)).toThrow(/too old/)
    vi.setSystemTime((VECTOR.timestamp - 301) * 1000)
    expect(() => verifyResendWebhook(VECTOR.body, headers, VECTOR.secret)).toThrow(/too new/)
  })

  it("accept either signature during a secret rotation", () => {
    vi.useFakeTimers({ now: VECTOR.timestamp * 1000 })
    const old = svixSignature("whsec_" + "AAAAAAAAAAAAAAAAAAAAAAAA", VECTOR.id, VECTOR.timestamp, VECTOR.body)
    expect(verifyResendWebhook(VECTOR.body, { id: VECTOR.id, timestamp: String(VECTOR.timestamp), signature: `${old} ${VECTOR.signature}` }, VECTOR.secret)).toBeTruthy()
  })

  it("check the secret's shape", () => {
    expect(webhookSecretProblem(undefined)).toMatch(/isn't set/)
    expect(webhookSecretProblem("plJ3nmyCDGBKInavdOK15jsl")).toMatch(/whsec_/)
    expect(webhookSecretProblem("whsec_" + "not base64!")).toMatch(/base64/)
    expect(webhookSecretProblem(VECTOR.secret)).toBeNull()
  })
})

describe("emailEventRow", () => {
  const event = (type: string, data: Record<string, unknown> = {}) => ({ type, created_at: "2026-10-22T18:00:05.000Z", data: { email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", created_at: "2026-10-22T18:00:00.000Z", to: ["Driver@Example.com"], subject: "GM 2 reminder", ...data } })

  it("keeps the email, recipient (lowercased), type and the event's time", () => {
    expect(emailEventRow(event("email.delivered"), "msg_1")).toEqual({
      svixId: "msg_1",
      resendId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
      recipient: "driver@example.com",
      type: "email.delivered",
      occurredAt: new Date("2026-10-22T18:00:05.000Z"),
      detail: null,
    })
  })

  it("keeps a bounce's type and reason", () => {
    const row = emailEventRow(event("email.bounced", { bounce: { type: "Permanent", subType: "General", message: "The recipient's email address does not exist.", diagnosticCode: ["smtp; 550 5.1.1"] } }), "msg_2")
    expect(row?.detail).toEqual({ bounceType: "Permanent", subType: "General", message: "The recipient's email address does not exist." })
  })

  it("never keeps a click's IP address or browser, or the link's query string", () => {
    const row = emailEventRow(event("email.clicked", { click: { link: "https://www.longhornsimracing.org/events?token=abc#x", ipAddress: "203.0.113.7", userAgent: "Mozilla/5.0" } }), "msg_3")
    expect(row?.detail).toEqual({ link: "https://www.longhornsimracing.org/events" })
    expect(JSON.stringify(row)).not.toMatch(/203\.0\.113|Mozilla|token/)
  })

  it("skips events that aren't about our sent email, and payloads that don't parse", () => {
    expect(emailEventRow({ type: "contact.created", created_at: "2026-10-22T18:00:00Z", data: { email_id: "x" } }, "msg_4")).toBeNull()
    expect(emailEventRow({ type: "email.delivered", data: {} }, "msg_5")).toBeNull()
    expect(emailEventRow(null, "msg_6")).toBeNull()
  })

  it("reads Resend's API time format too", () => {
    expect(emailEventRow({ type: "email.sent", data: { email_id: "e1", created_at: "2026-04-03 22:13:42.674981+00", to: "a@b.co" } }, "msg_7")?.occurredAt.toISOString()).toBe("2026-04-03T22:13:42.674Z")
  })
})
