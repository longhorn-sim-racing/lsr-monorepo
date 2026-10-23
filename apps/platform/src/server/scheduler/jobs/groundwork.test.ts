import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  scheduledJobRun: { deleteMany: vi.fn() },
  twitchViewerSample: { deleteMany: vi.fn() },
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { JOBS } from "./groundwork"

const NOW = Date.parse("2026-10-22T09:10:00Z")
const DAY = 86_400_000

const job = (kind: string) => {
  const found = JOBS.find((j) => j.kind === kind)
  if (!found) throw new Error(`No job ${kind}`)
  return found
}
const ctx = { signal: new AbortController().signal, deadline: NOW + 60_000, startedAt: NOW, log: () => {}, config: null, job: { id: "j", key: "k" } }

/** The SQL text of a tagged-template raw query call */
const sql = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?")

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  return () => vi.useRealTimers()
})

describe("housekeeping jobs", () => {
  it("prunes scheduled job runs older than 90 days", async () => {
    db.scheduledJobRun.deleteMany.mockResolvedValue({ count: 12 })
    expect(await job("housekeeping.job-runs").run(ctx)).toEqual({ summary: "Deleted 12 runs older than 90 days", counts: { deleted: 12 } })
    expect(db.scheduledJobRun.deleteMany).toHaveBeenCalledWith({ where: { startedAt: { lt: new Date(NOW - 90 * DAY) } } })
  })

  it("prunes pg_cron's run log older than 7 days, when this database has pg_cron", async () => {
    db.$queryRaw.mockResolvedValue([{ present: true }])
    db.$executeRaw.mockResolvedValue(1_440)
    expect(await job("housekeeping.cron-history").run(ctx)).toEqual({ summary: "Deleted 1440 run log rows older than 7 days", counts: { deleted: 1_440 } })
    expect(sql(db.$executeRaw.mock.calls[0])).toBe("DELETE FROM cron.job_run_details WHERE coalesce(end_time, start_time) < now() - interval '7 days'")
  })

  it("skips the pg_cron prune where there's no pg_cron (local copies, the shadow database)", async () => {
    db.$queryRaw.mockResolvedValue([{ present: false }])
    expect(await job("housekeeping.cron-history").run(ctx)).toMatchObject({ status: "skipped" })
    expect(db.$executeRaw).not.toHaveBeenCalled()
  })

  it("prunes Twitch viewer samples older than 180 days", async () => {
    db.twitchViewerSample.deleteMany.mockResolvedValue({ count: 0 })
    expect(await job("housekeeping.twitch-samples").run(ctx)).toEqual({ summary: "Nothing older than 180 days", counts: { deleted: 0 } })
    expect(db.twitchViewerSample.deleteMany).toHaveBeenCalledWith({ where: { at: { lt: new Date(NOW - 180 * DAY) } } })
  })

  it("are singletons that run inline, in the early morning", () => {
    for (const j of JOBS) {
      expect(j.singleton, j.kind).toBeUndefined()
      expect(j.handoff, j.kind).toBeUndefined()
      expect(j.defaultSchedule, j.kind).toMatch(/^\d+ 4 \* \* \*$/)
    }
  })
})
