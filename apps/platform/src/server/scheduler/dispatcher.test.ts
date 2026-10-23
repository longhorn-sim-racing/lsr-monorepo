import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { verifySchedulerSignature, SCHEDULER_SIGNATURE_HEADER, SCHEDULER_TIMESTAMP_HEADER } from "@/lib/scheduler-signature"
import { createFakeDb } from "./fake-db"
import type { JobContext, JobKind, JobResult } from "./types"

const fake = vi.hoisted(() => ({ store: null as ReturnType<typeof import("./fake-db").createFakeDb> | null }))
const kinds = vi.hoisted(() => new Map<string, JobKind>())

vi.mock("@/server/db", () => ({
  get prisma() {
    return fake.store!.db
  },
}))
vi.mock("./registry", () => ({ findJobKind: (kind: string) => kinds.get(kind) }))

import { acceptHandoff, dispatchDueJobs, parseHandoffRequest, runHandoff, CLAIM_WINDOW_MS, LOCK_MS, ORPHANED_RUN_ERROR } from "./dispatcher"

const SECRET = "s".repeat(64)
const START = Date.parse("2026-10-22T18:00:30Z")

let store: ReturnType<typeof createFakeDb>

function kind(name: string, run: (ctx: JobContext) => Promise<JobResult>, extra: Partial<JobKind> = {}): JobKind {
  const job: JobKind = { kind: name, label: name, description: "", defaultSchedule: "*/5 * * * *", budgetMs: 30_000, run, ...extra }
  kinds.set(name, job)
  return job
}

const ok = (summary = "Done") => async (): Promise<JobResult> => ({ summary })

/** Spins the microtask queue until `check` passes (the fake database only yields microtasks) */
async function until(check: () => unknown) {
  for (let i = 0; i < 10_000 && !check(); i++) await Promise.resolve()
  if (!check()) throw new Error("Never happened")
}
const dueAt = new Date(START - 30_000)

beforeEach(() => {
  store = createFakeDb()
  fake.store = store
  kinds.clear()
  vi.stubEnv("SCHEDULER_SIGNING_SECRET", SECRET)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("dispatchDueJobs", () => {
  it("claims a due job, runs it with its context, records the run and lets go of it", async () => {
    const run = vi.fn(async (ctx: JobContext): Promise<JobResult> => {
      ctx.log("Looked at 3 things")
      return { summary: "Synced 3 channels", counts: { channels: 3, messages: 41 } }
    })
    kind("discord.sync", run)
    const job = store.addJob({ kind: "discord.sync", schedule: "*/10 * * * *", nextRunAt: dueAt, config: { channels: ["a"] } })

    const result = await dispatchDueJobs({ startedAt: START, clock: () => START })

    expect(result).toEqual({ due: 1, started: [{ key: "discord.sync", status: "ok" }], unknown: [], deferred: [], lost: [] })
    const ctx = run.mock.calls[0][0]
    expect(ctx).toMatchObject({ startedAt: START, deadline: START + 30_000, config: { channels: ["a"] }, job: { id: job.id, key: "discord.sync" } })
    expect(ctx.signal.aborted).toBe(false)
    expect(store.runs).toHaveLength(1)
    expect(store.runs[0]).toMatchObject({ jobId: job.id, status: "ok", error: null, startedAt: new Date(START), summary: "Synced 3 channels\nchannels 3 · messages 41\nLooked at 3 things" })
    expect(store.runs[0].finishedAt).toBeInstanceOf(Date)
    // Next run from now (18:00:30 → 18:10), lock released, last run recorded
    expect(job).toMatchObject({ nextRunAt: new Date("2026-10-22T18:10:00Z"), lockedUntil: null, lastRunAt: new Date(START), lastStatus: "ok", lastError: null })
  })

  it("never runs a job twice when two ticks race for it: the conditional claim lets only one win", async () => {
    const run = vi.fn<JobKind["run"]>(ok())
    kind("stripe.sync", run)
    const job = store.addJob({ kind: "stripe.sync", nextRunAt: dueAt })

    const [a, b] = await Promise.all([dispatchDueJobs({ startedAt: START, clock: () => START }), dispatchDueJobs({ startedAt: START, clock: () => START })])

    expect(a.due + b.due).toBe(2) // both saw it due
    expect(run).toHaveBeenCalledTimes(1)
    expect([...a.lost, ...b.lost]).toEqual(["stripe.sync"])
    expect([...a.started, ...b.started]).toEqual([{ key: "stripe.sync", status: "ok" }])
    expect(store.runs.filter((r) => r.jobId === job.id)).toHaveLength(1)
  })

  it("skips kinds it doesn't know: never claimed, never failed, and the rest still run", async () => {
    kind("known", ok())
    const unknown = store.addJob({ kind: "from.a.newer.deploy", nextRunAt: dueAt })
    store.addJob({ kind: "known", nextRunAt: dueAt })

    const result = await dispatchDueJobs({ startedAt: START, clock: () => START })

    expect(result.unknown).toEqual(["from.a.newer.deploy"])
    expect(result.started).toEqual([{ key: "known", status: "ok" }])
    expect(unknown).toMatchObject({ lockedUntil: null, nextRunAt: dueAt, lastStatus: null })
    expect(store.runs.some((r) => r.jobId === unknown.id)).toBe(false)
  })

  it("leaves disabled, not-yet-due and locked jobs alone", async () => {
    const run = vi.fn<JobKind["run"]>(ok())
    kind("k", run)
    store.addJob({ kind: "k", key: "off", enabled: false, nextRunAt: dueAt })
    store.addJob({ kind: "k", key: "later", nextRunAt: new Date(START + 60_000) })
    store.addJob({ kind: "k", key: "busy", nextRunAt: dueAt, lockedUntil: new Date(START + 1000) })
    const expired = store.addJob({ kind: "k", key: "lock ran out", nextRunAt: dueAt, lockedUntil: new Date(START - 1000) })

    const result = await dispatchDueJobs({ startedAt: START, clock: () => START })

    expect(result.started).toEqual([{ key: "lock ran out", status: "ok" }])
    expect(run).toHaveBeenCalledTimes(1)
    expect(expired.lockedUntil).toBeNull()
  })

  it("stops claiming 200 s into the request, and only claims jobs whose budget fits the time left", async () => {
    const run = vi.fn<JobKind["run"]>(ok())
    kind("small", run, { budgetMs: 60_000 })
    kind("big", run, { budgetMs: 120_000 })
    kind("long", run, { budgetMs: 280_000, handoff: true })
    const fetch = vi.fn(async () => new Response(null, { status: 202 }))

    // 195 s in: 195 + 60 fits in 290, 195 + 120 doesn't; a hand-off always fits (it gets its own function)
    for (const k of ["small", "big", "long"]) store.addJob({ kind: k, nextRunAt: dueAt })
    const late = await dispatchDueJobs({ startedAt: START, clock: () => START + 195_000, fetch, baseUrl: "https://example.org" })
    expect(late.started).toHaveLength(2)
    expect(late.started).toEqual(expect.arrayContaining([
      { key: "small", status: "ok" },
      { key: "long", status: "handed_off" },
    ]))
    expect(late.deferred).toEqual(["big"])
    expect(store.jobs.find((j) => j.key === "big")).toMatchObject({ lockedUntil: null, nextRunAt: dueAt })

    // Past the claim window nothing new is claimed
    const tooLate = await dispatchDueJobs({ startedAt: START, clock: () => START + CLAIM_WINDOW_MS })
    expect(tooLate.started).toEqual([])
    expect(tooLate.deferred).toEqual(["big"])
  })

  it("caps a job's deadline at the end of the function", async () => {
    const run = vi.fn<JobKind["run"]>(ok())
    kind("k", run, { budgetMs: 100_000 })
    store.addJob({ kind: "k", nextRunAt: dueAt })
    await dispatchDueJobs({ startedAt: START, clock: () => START + 150_000 })
    expect(run.mock.calls[0][0].deadline).toBe(START + 250_000)
    store.jobs[0].nextRunAt = dueAt
    await dispatchDueJobs({ startedAt: START, clock: () => START + 190_000 })
    expect(run.mock.calls[1][0].deadline).toBe(START + 290_000)
  })

  it("runs at most 3 jobs at once", async () => {
    let running = 0
    let most = 0
    const run = async (): Promise<JobResult> => {
      running++
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      return { summary: "ok" }
    }
    kind("k", run)
    for (let i = 0; i < 7; i++) store.addJob({ kind: "k", key: `k${i}`, nextRunAt: dueAt })

    const result = await dispatchDueJobs({ startedAt: START, clock: () => START })

    expect(result.started).toHaveLength(7)
    expect(most).toBe(3)
  })

  it("computes the next run from now in Central time, across the end of daylight saving", async () => {
    kind("k", ok())
    // Claimed at 1:30:05 AM CDT on Nov 1: the repeated 1:30 AM (CST) an hour later doesn't count, so the next run is Nov 2
    const nightly = store.addJob({ kind: "k", key: "nightly", schedule: "30 1 * * *", nextRunAt: new Date("2026-11-01T06:30:00Z") })
    const morning = store.addJob({ kind: "k", key: "morning", schedule: "0 9 * * *", nextRunAt: new Date("2026-11-01T06:00:00Z") })
    const at = Date.parse("2026-11-01T06:30:05Z")
    await dispatchDueJobs({ startedAt: at, clock: () => at })
    expect(nightly.nextRunAt.toISOString()).toBe("2026-11-02T07:30:00.000Z")
    expect(morning.nextRunAt.toISOString()).toBe("2026-11-01T15:00:00.000Z") // 9 AM CST

    // Hours late, an hourly job runs once and its next run is the next hour from now, not the missed ones
    const hourly = store.addJob({ kind: "k", key: "hourly", schedule: "0 * * * *", nextRunAt: new Date("2026-10-22T10:00:00Z") })
    await dispatchDueJobs({ startedAt: START, clock: () => START })
    expect(store.runs.filter((r) => r.jobId === hourly.id)).toHaveLength(1)
    expect(hourly.nextRunAt.toISOString()).toBe("2026-10-22T19:00:00.000Z")
  })

  it("marks a run left 'running' by a function that died as failed when the job is next claimed", async () => {
    kind("k", ok())
    // Claimed 10 minutes ago; its lock ran out 4 minutes ago and the run never finished
    const job = store.addJob({ kind: "k", nextRunAt: dueAt, lockedUntil: new Date(START - 600_000 + LOCK_MS) })
    const orphan = store.addRun({ jobId: job.id, startedAt: new Date(START - 600_000) })
    const other = store.addRun({ jobId: "another-job", startedAt: new Date(START - 600_000) })

    await dispatchDueJobs({ startedAt: START, clock: () => START })

    expect(orphan).toMatchObject({ status: "error", error: ORPHANED_RUN_ERROR, finishedAt: new Date(START) })
    expect(other.status).toBe("running")
    expect(store.runs.filter((r) => r.jobId === job.id).map((r) => r.status)).toEqual(["error", "ok"])
  })

  it("records a failure through redactSecrets and lets go of the job", async () => {
    const key = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc"
    kind("k", async (ctx) => {
      ctx.log("Fetched page 1")
      throw new Error(`Stripe said no to ${key}`)
    })
    const job = store.addJob({ kind: "k", nextRunAt: dueAt })

    const result = await dispatchDueJobs({ startedAt: START, clock: () => START })

    expect(result.started).toEqual([{ key: "k", status: "error" }])
    expect(store.runs[0].error).toContain("[redacted]")
    expect(store.runs[0].error).not.toContain(key)
    expect(store.runs[0].summary).toBe("Fetched page 1")
    expect(job).toMatchObject({ lastStatus: "error", lockedUntil: null })
    expect(job.lastError).not.toContain(key)
  })

  it("records a job that had nothing to do as skipped", async () => {
    kind("k", async () => ({ summary: "Discord isn't connected", status: "skipped" }))
    const job = store.addJob({ kind: "k", nextRunAt: dueAt })
    await dispatchDueJobs({ startedAt: START, clock: () => START })
    expect(store.runs[0]).toMatchObject({ status: "skipped", summary: "Discord isn't connected" })
    expect(job.lastStatus).toBe("skipped")
  })

  it("fails a job whose saved schedule can't be read, and tries it again an hour later", async () => {
    const run = vi.fn<JobKind["run"]>(ok())
    kind("k", run)
    const job = store.addJob({ kind: "k", schedule: "every tuesday", nextRunAt: dueAt })
    await dispatchDueJobs({ startedAt: START, clock: () => START })
    expect(run).not.toHaveBeenCalled()
    expect(store.runs[0]).toMatchObject({ status: "error", error: expect.stringContaining("every tuesday") })
    expect(job).toMatchObject({ lastStatus: "error", lockedUntil: null, nextRunAt: new Date(START + 3_600_000) })
  })

  it("aborts the job's signal when its budget runs out, and records one that ignores it as failed, keeping its lock", async () => {
    vi.useFakeTimers({ now: START })
    let seen: AbortSignal | undefined
    kind("stubborn", (ctx) => {
      seen = ctx.signal
      return new Promise<JobResult>(() => {})
    }, { budgetMs: 1_000 })
    const job = store.addJob({ kind: "stubborn", nextRunAt: dueAt })

    const dispatching = dispatchDueJobs({ startedAt: START })
    await until(() => seen)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await dispatching

    expect(result.started).toEqual([{ key: "stubborn", status: "error" }])
    expect(store.runs[0].error).toMatch(/past its budget/)
    expect(job.lastStatus).toBe("error")
    expect(job.lockedUntil).toEqual(new Date(START + LOCK_MS))
  })

  it("lets a job that honors the abort signal finish with what it has", async () => {
    vi.useFakeTimers({ now: START })
    let started = false
    kind("polite", (ctx) => {
      started = true
      return new Promise<JobResult>((resolve) => ctx.signal.addEventListener("abort", () => resolve({ summary: "Stopped early: 40 of 90 done" })))
    }, { budgetMs: 1_000 })
    store.addJob({ kind: "polite", nextRunAt: dueAt })
    const dispatching = dispatchDueJobs({ startedAt: START })
    await until(() => started)
    await vi.advanceTimersByTimeAsync(1_000)
    await dispatching
    expect(store.runs[0]).toMatchObject({ status: "ok", summary: "Stopped early: 40 of 90 done" })
  })
})

describe("hand-offs", () => {
  const BASE = "https://www.example.org"

  it("sends a handoff job to /api/admin/jack/run, signed for that route only, and leaves it locked and running", async () => {
    const run = vi.fn<JobKind["run"]>(ok())
    kind("recurring.question", run, { handoff: true, budgetMs: 280_000, singleton: false })
    const job = store.addJob({ kind: "recurring.question", key: "recurring:q1", nextRunAt: dueAt })
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }))

    const result = await dispatchDueJobs({ startedAt: START, clock: () => START, fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: `${BASE}/` })

    expect(result.started).toEqual([{ key: "recurring:q1", status: "handed_off" }])
    expect(run).not.toHaveBeenCalled()
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(`${BASE}/api/admin/jack/run`)
    expect(init).toMatchObject({ method: "POST", redirect: "manual" })
    const headers = new Headers(init.headers)
    const body = String(init.body)
    expect(parseHandoffRequest(body)).toEqual({ jobId: job.id, runId: store.runs[0].id, lockedUntil: new Date(START + LOCK_MS).toISOString() })
    const signed = { timestamp: headers.get(SCHEDULER_TIMESTAMP_HEADER), signature: headers.get(SCHEDULER_SIGNATURE_HEADER), rawBody: body, nowMs: START, env: { SCHEDULER_SIGNING_SECRET: SECRET } }
    expect(verifySchedulerSignature({ ...signed, purpose: "run" })).toEqual({ ok: true })
    expect(verifySchedulerSignature({ ...signed, purpose: "tick" })).toEqual({ ok: false, reason: "bad_signature" })
    expect(store.runs[0].status).toBe("running")
    expect(job.lockedUntil).toEqual(new Date(START + LOCK_MS))
  })

  it("records a hand-off that didn't land (a redirect, an error, no answer) as failed and lets go of the job", async () => {
    kind("long", ok(), { handoff: true })
    for (const answer of [new Response(null, { status: 308, headers: { location: "https://elsewhere.example" } }), new Response(null, { status: 500 }), new Error("connect ECONNREFUSED")]) {
      store = createFakeDb()
      fake.store = store
      const job = store.addJob({ kind: "long", nextRunAt: dueAt })
      const fetch = vi.fn(async () => {
        if (answer instanceof Error) throw answer
        return answer
      })
      const result = await dispatchDueJobs({ startedAt: START, clock: () => START, fetch, baseUrl: BASE })
      expect(result.started).toEqual([{ key: "long", status: "error" }])
      expect(store.runs[0]).toMatchObject({ status: "error", error: expect.stringContaining("Couldn't hand the job off") })
      expect(job).toMatchObject({ lockedUntil: null, lastStatus: "error" })
    }
    expect(store.runs[0].error).toContain("ECONNREFUSED")
  })

  it("runs handoff jobs in place with handoff: 'inline' (pnpm jack:tick)", async () => {
    const run = vi.fn<JobKind["run"]>(ok("Asked the question"))
    kind("long", run, { handoff: true })
    store.addJob({ kind: "long", nextRunAt: dueAt })
    const fetch = vi.fn()
    const result = await dispatchDueJobs({ startedAt: START, clock: () => START, handoff: "inline", fetch })
    expect(result.started).toEqual([{ key: "long", status: "ok" }])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("takes a hand-off over exactly once, runs it with the route's own deadline, and lets go after", async () => {
    const run = vi.fn<JobKind["run"]>(ok("Answered"))
    kind("long", run, { handoff: true, budgetMs: 280_000 })
    const job = store.addJob({ kind: "long", nextRunAt: dueAt })
    let request: string | undefined
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      request = String(init.body)
      return new Response(null, { status: 202 })
    })
    await dispatchDueJobs({ startedAt: START, clock: () => START, fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: BASE })

    const routeStart = START + 2_000
    const body = parseHandoffRequest(request!)!
    const accepted = await acceptHandoff(body, routeStart, () => routeStart)
    expect(accepted.ok).toBe(true)
    expect(job.lockedUntil).toEqual(new Date(routeStart + LOCK_MS))

    // A replay finds the lock already swapped
    expect(await acceptHandoff(body, routeStart + 5_000)).toEqual({ ok: false, error: expect.stringContaining("isn't waiting") })

    if (!accepted.ok) throw new Error("unreachable")
    expect(await runHandoff(accepted.handoff, routeStart, () => routeStart)).toBe("ok")
    expect(run.mock.calls[0][0]).toMatchObject({ startedAt: routeStart, deadline: routeStart + 280_000 })
    expect(store.runs).toHaveLength(1)
    expect(store.runs[0]).toMatchObject({ status: "ok", summary: "Answered", startedAt: new Date(START) })
    expect(job).toMatchObject({ lockedUntil: null, lastStatus: "ok", lastRunAt: new Date(START) })
  })

  it("refuses a hand-off for a kind this code doesn't know, failing its run", async () => {
    const job = store.addJob({ kind: "gone", nextRunAt: new Date(START + 60_000), lockedUntil: new Date(START + LOCK_MS) })
    const open = store.addRun({ jobId: job.id, startedAt: new Date(START) })
    const result = await acceptHandoff({ jobId: job.id, runId: open.id, lockedUntil: new Date(START + LOCK_MS).toISOString() }, START + 1_000)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('"gone"') })
    expect(open.status).toBe("error")
    expect(job.lockedUntil).toBeNull()
  })

  it("only parses well-formed hand-off bodies", () => {
    expect(parseHandoffRequest("not json")).toBeNull()
    expect(parseHandoffRequest(JSON.stringify({ jobId: "j" }))).toBeNull()
    expect(parseHandoffRequest(JSON.stringify({ jobId: "j", runId: "r", lockedUntil: "tomorrow" }))).toBeNull()
    expect(parseHandoffRequest(JSON.stringify({ jobId: "j", runId: "r", lockedUntil: "2026-10-22T18:06:30.000Z" }))).toEqual({ jobId: "j", runId: "r", lockedUntil: "2026-10-22T18:06:30.000Z" })
  })
})
