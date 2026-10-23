import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  schedulerHeartbeat: { upsert: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  $queryRaw: vi.fn(),
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { getSchedulerHealth, heartbeatState, recordDispatch } from "./heartbeat"

const now = new Date("2026-10-22T18:00:00Z")
const sql = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?")

beforeEach(() => {
  db.schedulerHeartbeat.findUnique.mockResolvedValue({ id: "tick", lastTickAt: new Date("2026-10-22T17:59:00Z"), lastDispatchAt: null })
})

describe("the scheduler heartbeat", () => {
  it("is ok within 10 minutes of a tick, stale after, and 'never' without one", () => {
    expect(heartbeatState(new Date("2026-10-22T17:50:00Z"), now)).toBe("ok")
    expect(heartbeatState(new Date("2026-10-22T17:49:59Z"), now)).toBe("stale")
    expect(heartbeatState(null, now)).toBe("never")
  })

  it("records a dispatch on the existing row only, so a tick that never happened isn't made up", async () => {
    await recordDispatch(now)
    expect(db.schedulerHeartbeat.updateMany).toHaveBeenCalledWith({ where: { id: "tick" }, data: { lastDispatchAt: now } })
    expect(db.schedulerHeartbeat.upsert).not.toHaveBeenCalled()
  })

  it("counts pnpm jack:tick as a tick too", async () => {
    await recordDispatch(now, { tick: true })
    expect(db.schedulerHeartbeat.upsert).toHaveBeenCalledWith({
      where: { id: "tick" },
      create: { id: "tick", lastTickAt: now, lastDispatchAt: now },
      update: { lastTickAt: now, lastDispatchAt: now },
    })
  })

  it("reads pg_cron's tick job and pg_net's answers, redacting what they say", async () => {
    const leaked = "Bearer " + "abc123def456ghi789jkl0"
    db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join("?")
      if (text.includes("to_regclass('cron.job')")) return [{ present: true }]
      if (text.includes("to_regclass('net._http_response')")) return [{ present: true }]
      if (text.includes("FROM cron.job j")) return [{ schedule: "* * * * *", active: true, status: "failed", message: `connection failed ${leaked}`, at: now }]
      if (text.includes("count(*)")) return [{ ok: 12, failed: 1 }]
      return [{ status: 401, timedOut: false, error: null, at: now }]
    })

    const health = await getSchedulerHealth(now)

    expect(health).toMatchObject({ state: "ok", lastTickAt: new Date("2026-10-22T17:59:00Z"), lastDispatchAt: null })
    expect(health.cron).toMatchObject({ scheduled: true, active: true, schedule: "* * * * *", lastRun: { status: "failed" } })
    expect(health.cron && "lastRun" in health.cron ? health.cron.lastRun?.message : "").not.toContain("abc123def456ghi789jkl0")
    expect(health.delivery).toEqual({ ok: 12, failed: 1, lastFailure: { status: 401, error: null, at: now } })
    expect(db.$queryRaw.mock.calls.map(sql).some((text) => text.includes("WHERE j.jobname = ?"))).toBe(true)
  })

  it("says nothing about pg_cron or pg_net where the database has neither, and survives a failed read", async () => {
    db.$queryRaw.mockResolvedValue([{ present: false }])
    expect(await getSchedulerHealth(now)).toMatchObject({ cron: null, delivery: null })

    vi.spyOn(console, "error").mockImplementation(() => {})
    db.$queryRaw.mockRejectedValue(new Error("permission denied for schema cron"))
    expect(await getSchedulerHealth(now)).toMatchObject({ state: "ok", cron: null, delivery: null })
  })

  it("tells a scheduled tick job from a missing one", async () => {
    db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => (strings.join("?").includes("to_regclass") ? [{ present: true }] : strings.join("?").includes("count(*)") ? [{ ok: 0, failed: 0 }] : []))
    const health = await getSchedulerHealth(now)
    expect(health.cron).toEqual({ scheduled: false })
    expect(health.delivery).toEqual({ ok: 0, failed: 0, lastFailure: null })
  })
})
