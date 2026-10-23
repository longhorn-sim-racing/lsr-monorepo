import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The SDK reads RESEND_BASE_URL once, when it loads: set it before anything imports "resend" (groundwork.md, "SDK notes")
vi.hoisted(() => {
  process.env.RESEND_BASE_URL = "http://127.0.0.1:3999/resend"
})

const stored = vi.hoisted(() => ({ rows: [] as { svixId: string; resendId: string; recipient: string; type: string; occurredAt: Date; detail: unknown }[] }))
vi.mock("@/server/db", () => ({
  prisma: {
    emailEvent: {
      createMany: vi.fn(async ({ data }: { data: (typeof stored.rows)[number][] }) => {
        const fresh = data.filter((row) => !stored.rows.some((s) => s.svixId === row.svixId))
        stored.rows.push(...fresh)
        return { count: fresh.length }
      }),
    },
    connectorState: { upsert: vi.fn() },
  },
}))

import { Resend } from "resend"
import { POST } from "@/app/api/webhooks/resend/route"
import { mountFakes } from "../../fakes/testing"
import type { FakeService } from "../../fakes/types"
import { summarizeEvents } from "../delivery"
import { outcomeFor, resendFake } from "./handlers"

const KEY = "re_" + "test_" + "x".repeat(20)
const SEND_ONLY_KEY = "re_" + "send_" + "x".repeat(20)
const SECRET = "whsec_" + Buffer.from("resend-fake-test-secret-32-bytes").toString("base64")

/** The app's own webhook route, mounted next to the fakes so the fake's sender can reach it */
const app: FakeService = { id: "app", create: () => [{ method: "POST", path: "/api/webhooks/resend", handle: (request) => POST(request) }] }
const TARGET = "http://127.0.0.1:3999/app/api/webhooks/resend"

beforeEach(() => {
  stored.rows = []
  vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const email = (to: string, subject = "GM 2 reminder") => ({ from: "LSR <noreply@longhornsimracing.org>", to, subject, html: "<p>Hi</p>" })

describe("the Resend fake", () => {
  it("takes sends from the real SDK, then delivers signed events the app's route stores", async () => {
    mountFakes([resendFake, app])
    const resend = new Resend(KEY)
    const sent = await resend.batch.send([email("delivered@resend.dev"), email("bounced+gm2@resend.dev"), email("complained@resend.dev"), email("suppressed@resend.dev")])
    expect(sent.error).toBeNull()
    const ids = sent.data!.data.map((d) => d.id)

    const answer = await fetch("http://127.0.0.1:3999/resend/_fake/webhooks", { method: "POST", body: JSON.stringify({ target: TARGET, outOfOrder: true }) })
    expect(await answer.json()).toMatchObject({ ok: true, refused: 0 })

    const delivery = summarizeEvents(stored.rows)
    expect(ids.map((id) => delivery.get(id)?.status)).toEqual(["delivered", "bounced", "complained", "suppressed"])
    expect(delivery.get(ids[1])?.reason).toMatch(/Permanent: The recipient's email address does not exist/)
  })

  it("dedupes duplicate deliveries on svix-id", async () => {
    mountFakes([resendFake, app])
    await new Resend(KEY).emails.send(email("delivered@resend.dev"))
    const answer = await (await fetch("http://127.0.0.1:3999/resend/_fake/webhooks", { method: "POST", body: JSON.stringify({ target: TARGET, duplicate: true }) })).json()
    expect(answer.posted).toBe(4)
    expect(stored.rows.map((r) => r.type).sort()).toEqual(["email.delivered", "email.sent"])
  })

  it("drops a click's IP address and browser on the way in", async () => {
    mountFakes([resendFake, app])
    await new Resend(KEY).emails.send(email("clicked@resend.dev"))
    await fetch("http://127.0.0.1:3999/resend/_fake/webhooks", { method: "POST", body: JSON.stringify({ target: TARGET }) })
    expect(stored.rows.find((r) => r.type === "email.clicked")?.detail).toEqual({ link: "https://www.longhornsimracing.org/events" })
    expect(JSON.stringify(stored.rows)).not.toMatch(/203\.0\.113|Mozilla|token=/)
  })

  it("refuses reads with a send-only key, like the production key", async () => {
    mountFakes([resendFake])
    const { data } = await new Resend(KEY).emails.send(email("delivered@resend.dev"))
    expect((await new Resend(SEND_ONLY_KEY).emails.get(data!.id)).error).toMatchObject({ name: "restricted_api_key" })
    expect((await new Resend(KEY).emails.get(data!.id)).data).toMatchObject({ id: data!.id, last_event: "sent" })
  })

  it("validates batches strictly unless asked to be permissive", async () => {
    mountFakes([resendFake])
    const resend = new Resend(KEY)
    const bad = [email("delivered@resend.dev"), { ...email("delivered@resend.dev"), to: "not an address" }]
    expect((await resend.batch.send(bad)).error).toMatchObject({ statusCode: 422 })
    const permissive = await resend.batch.send(bad, { batchValidation: "permissive" })
    expect(permissive.data).toMatchObject({ data: [{ id: expect.any(String) }], errors: [{ index: 1 }] })
  })

  it("replays an Idempotency-Key, and refuses one reused for a different email", async () => {
    mountFakes([resendFake])
    const resend = new Resend(KEY)
    const first = await resend.emails.send(email("delivered@resend.dev"), { idempotencyKey: "notification:n1" })
    const again = await resend.emails.send(email("delivered@resend.dev"), { idempotencyKey: "notification:n1" })
    expect(again.data?.id).toBe(first.data?.id)
    expect((await resend.emails.send(email("delivered@resend.dev", "Other"), { idempotencyKey: "notification:n1" })).error).toMatchObject({ name: "invalid_idempotent_request" })
  })

  it("stops at the free plan's 100 recipients a day", async () => {
    mountFakes([resendFake])
    const resend = new Resend(KEY)
    // Batches count one request each, so this stays under 10 requests a second
    const batch = Array.from({ length: 100 }, (_, i) => email(`delivered+${i}@resend.dev`))
    expect((await resend.batch.send(batch)).error).toBeNull()
    expect((await resend.emails.send(email("delivered@resend.dev"))).error).toMatchObject({ name: "daily_quota_exceeded" })
  })

  it("picks outcomes by test inbox, +labels allowed", () => {
    expect(outcomeFor("bounced+lsc@resend.dev")).toEqual(["email.sent", "email.bounced"])
    expect(outcomeFor("delayed@resend.dev")).toEqual(["email.sent", "email.delivery_delayed", "email.bounced"])
    expect(outcomeFor("someone@utexas.edu")).toEqual(["email.sent", "email.delivered"])
  })
})
