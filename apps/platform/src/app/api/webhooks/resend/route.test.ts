import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = vi.hoisted(() => ({
  emailEvent: { createMany: vi.fn() },
  connectorState: { upsert: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma }))

import { svixSignature } from "@/server/connectors/resend/svix"
import { POST } from "./route"

const SECRET = "whsec_" + Buffer.from("a-test-signing-secret-32-bytes!!").toString("base64")

function delivery({ type = "email.bounced", id = "msg_test_1", secret = SECRET, at = Math.floor(Date.now() / 1000), body, headers = {} }: { type?: string; id?: string; secret?: string; at?: number; body?: string; headers?: Record<string, string> } = {}) {
  const raw =
    body ??
    JSON.stringify({
      type,
      created_at: new Date(at * 1000).toISOString(),
      data: { email_id: "e-123", created_at: new Date(at * 1000).toISOString(), to: ["member@example.com"], subject: "GM 2 reminder", bounce: { type: "Permanent", subType: "General", message: "No such user" } },
    })
  return new Request("http://localhost:3132/api/webhooks/resend", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(at), "svix-signature": svixSignature(secret, id, at, raw), ...headers },
    body: raw,
  })
}

beforeEach(() => {
  vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET)
  prisma.emailEvent.createMany.mockResolvedValue({ count: 1 })
  prisma.connectorState.upsert.mockResolvedValue({})
})

describe("POST /api/webhooks/resend", () => {
  it("stores a signed event once and records the connector's last event", async () => {
    const res = await POST(delivery())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stored: true })
    expect(prisma.emailEvent.createMany).toHaveBeenCalledWith({
      data: [{ svixId: "msg_test_1", resendId: "e-123", recipient: "member@example.com", type: "email.bounced", occurredAt: expect.any(Date), detail: { bounceType: "Permanent", subType: "General", message: "No such user" } }],
      skipDuplicates: true,
    })
    expect(prisma.connectorState.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "resend" } }))
  })

  it("answers a retried delivery (same svix-id) with 200 and stores nothing new", async () => {
    prisma.emailEvent.createMany.mockResolvedValue({ count: 0 })
    const res = await POST(delivery())
    expect(await res.json()).toEqual({ ok: true, stored: false })
    expect(prisma.connectorState.upsert).not.toHaveBeenCalled()
  })

  it("fails closed without the secret (503, so Resend retries once it's set)", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "")
    expect((await POST(delivery())).status).toBe(503)
    expect(prisma.emailEvent.createMany).not.toHaveBeenCalled()
  })

  it("refuses a bad signature, a stale timestamp, a changed body or missing headers", async () => {
    expect((await POST(delivery({ secret: "whsec_" + Buffer.from("another-secret-of-thirty-two-b!!").toString("base64") }))).status).toBe(400)
    expect((await POST(delivery({ at: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(400)
    const good = delivery()
    const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: (await good.text()).replace("member@", "attacker@") })
    expect((await POST(tampered)).status).toBe(400)
    const noHeaders = new Request("http://localhost/api/webhooks/resend", { method: "POST", body: "{}" })
    expect((await POST(noHeaders)).status).toBe(400)
    expect(prisma.emailEvent.createMany).not.toHaveBeenCalled()
  })

  it("accepts a delivery signed with the old and the new secret during a rotation", async () => {
    const req = delivery()
    const at = req.headers.get("svix-timestamp")!
    const raw = await req.clone().text()
    const old = svixSignature("whsec_" + Buffer.from("the-old-signing-secret-32-bytes!").toString("base64"), "msg_test_1", Number(at), raw)
    const both = new Request(req.url, { method: "POST", headers: { ...Object.fromEntries(req.headers), "svix-signature": `${old} ${req.headers.get("svix-signature")}` }, body: raw })
    expect((await POST(both)).status).toBe(200)
  })

  it("acknowledges events it doesn't keep without storing them", async () => {
    const res = await POST(delivery({ body: JSON.stringify({ type: "contact.created", created_at: new Date().toISOString(), data: { id: "c1" } }) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stored: false })
    expect(prisma.emailEvent.createMany).not.toHaveBeenCalled()
  })

  it("answers 500 when the database fails (so Resend retries), without logging the address", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    prisma.emailEvent.createMany.mockRejectedValue(new Error("insert failed for member@example.com"))
    expect((await POST(delivery())).status).toBe(500)
    expect(log.mock.calls.flat().join(" ")).not.toContain("member@example.com")
  })

  it("refuses a body far bigger than any event", async () => {
    expect((await POST(delivery({ body: "x".repeat(300_000) }))).status).toBe(413)
  })
})
