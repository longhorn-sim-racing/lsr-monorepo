import { beforeEach, describe, expect, it, vi } from "vitest"
import { schedulerSignature, signSchedulerRequest } from "@/lib/scheduler-signature"

const dispatcher = vi.hoisted(() => ({ acceptHandoff: vi.fn(), runHandoff: vi.fn() }))
const after = vi.hoisted(() => ({ tasks: [] as (() => Promise<unknown>)[] }))

// The real body parser; taking the claim over and running the job are faked
vi.mock("@/server/scheduler/dispatcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/scheduler/dispatcher")>()
  return { ...dispatcher, parseHandoffRequest: actual.parseHandoffRequest }
})
vi.mock("@/server/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    after.tasks.push(task)
    return Promise.resolve()
  },
}))

import * as route from "./route"

const SECRET = "d".repeat(64)
const BODY = JSON.stringify({ jobId: "job-1", runId: "run-1", lockedUntil: "2026-10-22T18:06:30.000Z" })
const accepted = { job: { id: "job-1", key: "recurring:q1" }, kind: { kind: "recurring.question" }, claim: { runId: "run-1" } }

function handoff(body = BODY, headers: Record<string, string> = signSchedulerRequest(body, "run", { env: { SCHEDULER_SIGNING_SECRET: SECRET } })) {
  return new Request("https://www.example.org/api/admin/jack/run", { method: "POST", headers, body })
}

beforeEach(() => {
  after.tasks = []
  vi.stubEnv("SCHEDULER_SIGNING_SECRET", SECRET)
  dispatcher.acceptHandoff.mockResolvedValue({ ok: true, handoff: accepted })
  dispatcher.runHandoff.mockResolvedValue("ok")
})

describe("POST /api/admin/jack/run", () => {
  it("takes the hand-off over, answers 202 and runs the job after the response with this request's start", async () => {
    const before = Date.now()
    const res = await route.POST(handoff())
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true })
    expect(dispatcher.acceptHandoff).toHaveBeenCalledWith({ jobId: "job-1", runId: "run-1", lockedUntil: "2026-10-22T18:06:30.000Z" }, expect.any(Number))
    const startedAt = dispatcher.acceptHandoff.mock.calls[0][1]
    expect(startedAt).toBeGreaterThanOrEqual(before)

    expect(dispatcher.runHandoff).not.toHaveBeenCalled()
    await after.tasks[0]()
    expect(dispatcher.runHandoff).toHaveBeenCalledWith(accepted, startedAt)
  })

  it("refuses unsigned requests, and a tick's signature (each purpose signs different text)", async () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const refused = [
      handoff(BODY, { "content-type": "application/json" }),
      handoff(BODY, { "x-lsr-timestamp": ts, "x-lsr-signature": schedulerSignature(SECRET, ts, BODY, "tick") }),
      handoff(BODY, signSchedulerRequest(BODY, "run", { env: { SCHEDULER_SIGNING_SECRET: "x".repeat(64) } })),
    ]
    for (const request of refused) expect((await route.POST(request)).status).toBe(401)
    expect(dispatcher.acceptHandoff).not.toHaveBeenCalled()
  })

  it("fails closed when no secret is configured", async () => {
    const request = handoff()
    vi.stubEnv("SCHEDULER_SIGNING_SECRET", "")
    expect((await route.POST(request)).status).toBe(401)
  })

  it("answers 400 for a signed body that isn't a hand-off", async () => {
    const body = JSON.stringify({ jobId: "job-1" })
    expect((await route.POST(handoff(body, signSchedulerRequest(body, "run", { env: { SCHEDULER_SIGNING_SECRET: SECRET } })))).status).toBe(400)
    expect(dispatcher.acceptHandoff).not.toHaveBeenCalled()
  })

  it("answers 409 for a hand-off it can't take over (a replay, or the job moved on), and runs nothing", async () => {
    dispatcher.acceptHandoff.mockResolvedValue({ ok: false, error: "That job isn't waiting for this hand-off" })
    const res = await route.POST(handoff())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: "That job isn't waiting for this hand-off" })
    expect(after.tasks).toHaveLength(0)
  })

  it("is a 300-second function with no GET", () => {
    expect(route.maxDuration).toBe(300)
    expect(Object.keys(route)).not.toContain("GET")
  })
})
