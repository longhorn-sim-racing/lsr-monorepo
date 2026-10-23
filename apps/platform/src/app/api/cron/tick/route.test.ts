import { beforeEach, describe, expect, it, vi } from "vitest"
import { schedulerSignature, tickBody } from "@/lib/scheduler-signature"

const dispatcher = vi.hoisted(() => ({ countDueJobs: vi.fn(), dispatchDueJobs: vi.fn() }))
const heartbeat = vi.hoisted(() => ({ recordDispatch: vi.fn() }))
const after = vi.hoisted(() => ({ tasks: [] as (() => Promise<unknown>)[] }))

vi.mock("@/server/scheduler/dispatcher", () => dispatcher)
vi.mock("@/server/scheduler/heartbeat", () => heartbeat)
vi.mock("@/server/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    after.tasks.push(task)
    return Promise.resolve()
  },
}))

import * as route from "./route"

const SECRET = "f".repeat(64)

/** A tick as pg_net sends it: jsonb text, signed over the timestamp and that exact text */
function tick({ secret = SECRET, at = Date.now(), body, purpose = "tick" as const, headers = {} }: { secret?: string; at?: number; body?: string; purpose?: "tick" | "run"; headers?: Record<string, string> } = {}) {
  const ts = String(Math.floor(at / 1000))
  const raw = body ?? tickBody(Number(ts), "5f0c2d6e-0000-4000-8000-000000000000")
  return new Request("http://localhost:3113/api/cron/tick", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "pg_net/0.20.4", "x-lsr-timestamp": ts, "x-lsr-signature": schedulerSignature(secret, ts, raw, purpose), ...headers },
    body: raw,
  })
}

beforeEach(() => {
  after.tasks = []
  vi.stubEnv("SCHEDULER_SIGNING_SECRET", SECRET)
  dispatcher.countDueJobs.mockResolvedValue(2)
  dispatcher.dispatchDueJobs.mockResolvedValue({ due: 2, started: [], unknown: [], deferred: [], lost: [] })
  heartbeat.recordDispatch.mockResolvedValue(undefined)
})

describe("POST /api/cron/tick", () => {
  it("answers 202 with the due count only, records the dispatch and runs the jobs after the response", async () => {
    const res = await route.POST(tick())
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, due: 2 })
    expect(heartbeat.recordDispatch).toHaveBeenCalledWith(expect.any(Date))
    expect(dispatcher.dispatchDueJobs).not.toHaveBeenCalled()

    expect(after.tasks).toHaveLength(1)
    await after.tasks[0]()
    expect(dispatcher.dispatchDueJobs).toHaveBeenCalledWith({ startedAt: expect.any(Number), baseUrl: "http://localhost:3113" })
  })

  it("hands off to the canonical site in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.longhornsimracing.org")
    await route.POST(tick())
    await after.tasks[0]()
    expect(dispatcher.dispatchDueJobs).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://www.longhornsimracing.org" }))
  })

  it("doesn't dispatch when nothing is due", async () => {
    dispatcher.countDueJobs.mockResolvedValue(0)
    const res = await route.POST(tick())
    expect(await res.json()).toEqual({ ok: true, due: 0 })
    expect(after.tasks).toHaveLength(0)
  })

  it("accepts the previous secret while rotating", async () => {
    vi.stubEnv("SCHEDULER_SIGNING_SECRET_PREVIOUS", "e".repeat(64))
    expect((await route.POST(tick({ secret: "e".repeat(64) }))).status).toBe(202)
  })

  it("refuses with 401 and does nothing: wrong secret, no signature, stale or future timestamp, a hand-off signature", async () => {
    const refused = [
      tick({ secret: "0".repeat(64) }),
      tick({ headers: { "x-lsr-signature": "" } }),
      tick({ at: Date.now() - 301_000 }),
      tick({ at: Date.now() + 301_000 }),
      tick({ purpose: "run" }),
      new Request("http://localhost:3113/api/cron/tick", { method: "POST", body: "{}" }),
    ]
    for (const request of refused) {
      const res = await route.POST(request)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ ok: false })
    }
    expect(dispatcher.countDueJobs).not.toHaveBeenCalled()
    expect(heartbeat.recordDispatch).not.toHaveBeenCalled()
    expect(after.tasks).toHaveLength(0)
  })

  it("checks the raw body: the same JSON re-serialized doesn't verify", async () => {
    const at = Date.now()
    const ts = Math.floor(at / 1000)
    const sent = tickBody(ts, "n")
    const request = tick({ at, body: sent })
    // Same headers, body re-written by JSON.stringify (no spaces, different key order)
    const reserialized = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(JSON.parse(sent)) })
    expect((await route.POST(reserialized)).status).toBe(401)
  })

  it("fails closed when no secret is configured", async () => {
    vi.stubEnv("SCHEDULER_SIGNING_SECRET", "")
    expect((await route.POST(tick({ secret: "" }))).status).toBe(401)
  })

  it("refuses oversized bodies before checking them", async () => {
    expect((await route.POST(tick({ body: "x".repeat(5_000) }))).status).toBe(413)
  })

  it("answers 500 without details when the database is down", async () => {
    dispatcher.countDueJobs.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"))
    const res = await route.POST(tick())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false })
  })

  it("only takes POST (a redirect turning pg_net's POST into a GET gets a 405 from Next)", () => {
    expect(Object.keys(route)).not.toContain("GET")
    expect(route.maxDuration).toBe(300)
  })
})
