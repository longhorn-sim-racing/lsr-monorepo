import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ stored: [] as { date: Date }[], writes: [] as { deleted: Date; rows: { date: Date; dimension: string; key: string; pageviews: number; visitors: number }[] }[] }))
vi.mock("@/server/db", () => ({
  prisma: {
    siteTrafficDaily: {
      findMany: vi.fn(async () => db.stored),
      deleteMany: vi.fn((args: { where: { date: Date } }) => ({ op: "delete", date: args.where.date })),
      createMany: vi.fn((args: { data: (typeof db.writes)[number]["rows"] }) => ({ op: "create", rows: args.data })),
    },
    $transaction: vi.fn(async (ops: [{ date: Date }, { rows: (typeof db.writes)[number]["rows"] }]) => {
      db.writes.push({ deleted: ops[0].date, rows: ops[1].rows })
    }),
  },
}))

import { mountFakes } from "../fakes/testing"
import { SiteTrafficApiError, siteTrafficClient, type SiteTrafficClient } from "./client"
import { SITE_TRAFFIC_FAKE_PROJECT, SITE_TRAFFIC_FAKE_TOKEN, siteTrafficFake } from "./fake/handlers"
import { SNAPSHOT_WINDOW_DAYS, snapshotSiteTraffic, windowDays } from "./snapshot"

beforeEach(() => {
  db.stored = []
  db.writes = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("windowDays", () => {
  it("lists the complete UTC days of the window, oldest first, never today", () => {
    const days = windowDays(new Date("2026-10-22T09:30:00Z"))
    expect(days).toHaveLength(SNAPSHOT_WINDOW_DAYS)
    expect(days[0]).toBe("2026-09-23")
    expect(days[days.length - 1]).toBe("2026-10-21")
  })
})

describe("snapshotSiteTraffic", () => {
  it("backfills every missing day of the window against the fake, a day's rows replaced together", async () => {
    const fakes = mountFakes([siteTrafficFake])
    const result = await snapshotSiteTraffic(siteTrafficClient(SITE_TRAFFIC_FAKE_TOKEN, SITE_TRAFFIC_FAKE_PROJECT))
    expect(result.counts.days).toBe(SNAPSHOT_WINDOW_DAYS)
    expect(result.more).toBe(false)
    expect(db.writes).toHaveLength(SNAPSHOT_WINDOW_DAYS)
    const first = db.writes[0]
    expect(first.rows.every((row) => row.date.getTime() === first.deleted.getTime())).toBe(true)
    expect(first.rows.filter((row) => row.dimension === "total")).toEqual([expect.objectContaining({ key: "all" })])
    expect(new Set(first.rows.map((row) => row.dimension))).toEqual(new Set(["total", "path", "referrer", "country", "device"]))
    // Five reads a day: the count and four groupings
    expect(fakes.requests).toHaveLength(SNAPSHOT_WINDOW_DAYS * 5)
  })

  it("only fetches the days it doesn't have", async () => {
    const fakes = mountFakes([siteTrafficFake])
    const days = windowDays(new Date())
    db.stored = days.slice(0, -2).map((day) => ({ date: new Date(`${day}T00:00:00.000Z`) }))
    const result = await snapshotSiteTraffic(siteTrafficClient(SITE_TRAFFIC_FAKE_TOKEN, SITE_TRAFFIC_FAKE_PROJECT))
    expect(result.counts.days).toBe(2)
    expect(fakes.requests).toHaveLength(10)

    db.stored = days.map((day) => ({ date: new Date(`${day}T00:00:00.000Z`) }))
    expect((await snapshotSiteTraffic(siteTrafficClient(SITE_TRAFFIC_FAKE_TOKEN, SITE_TRAFFIC_FAKE_PROJECT))).summary).toMatch(/already stored/)
  })

  /** A client whose calls fail the given way for one day */
  const failing = (day: string, error: Error): SiteTrafficClient => ({
    count: async (range) => {
      if (range.since.toISOString().startsWith(day)) throw error
      return { pageviews: 3, visitors: 2 }
    },
    top: async () => [{ key: "/", pageviews: 3, visitors: 2 }],
  })

  it("skips a day Vercel says is outside the plan's window, and carries on", async () => {
    const days = windowDays(new Date())
    const log = vi.fn()
    const result = await snapshotSiteTraffic(failing(days[0], new SiteTrafficApiError(402, "payment_required", "outside the window")), { log })
    expect(result.counts).toMatchObject({ days: SNAPSHOT_WINDOW_DAYS - 1, skipped: 1 })
    expect(log).toHaveBeenCalledWith(expect.stringContaining(days[0]))
  })

  it("stops on a rate limit and leaves the rest for the next run", async () => {
    const days = windowDays(new Date())
    const result = await snapshotSiteTraffic(failing(days[3], new SiteTrafficApiError(429, "rate_limited", "slow down")))
    expect(result.more).toBe(true)
    expect(result.counts.days).toBeLessThan(SNAPSHOT_WINDOW_DAYS)
    expect(result.summary).toMatch(/next run continues/)
  })

  it("fails the run on a token or project problem", async () => {
    const days = windowDays(new Date())
    await expect(snapshotSiteTraffic(failing(days[0], new SiteTrafficApiError(403, "forbidden", "Vercel answered 403")))).rejects.toThrow("Vercel answered 403")
  })

  it("stops at the deadline", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await snapshotSiteTraffic(failing("never", new Error("unused")), { signal: controller.signal })
    expect(result).toMatchObject({ more: true, counts: { days: 0 } })
  })
})
