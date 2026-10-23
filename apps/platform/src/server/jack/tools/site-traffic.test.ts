import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  read: { trafficCoverage: vi.fn(), trafficDaily: vi.fn(), trafficTop: vi.fn(), trafficKeyDaily: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/connectors/site-traffic/connector", () => ({ siteTrafficConnector: { status: mocks.status } }))
vi.mock("@/server/connectors/site-traffic/read", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/connectors/site-traffic/read")>()), ...mocks.read }))

import { percentChange, shiftDay, totalsOf } from "@/server/connectors/site-traffic/read"
import { siteTrafficTool } from "./site-traffic"

const run = (input: Record<string, unknown> = {}) => siteTrafficTool.run(siteTrafficTool.input.parse(input), { roomId: "r1", actor: { userId: "u1", displayName: "Gray" } })
const days = (from: string, count: number, pageviews: number, visitors: number) => Array.from({ length: count }, (_, i) => ({ day: shiftDay(from, i), pageviews, visitors }))

beforeEach(() => {
  mocks.status.mockResolvedValue({ state: "connected", lastSyncAt: new Date().toISOString(), missingEnv: [], missingSettings: [] })
  mocks.read.trafficCoverage.mockResolvedValue({ first: "2026-09-23", last: "2026-10-21", days: 29 })
  mocks.read.trafficDaily.mockImplementation(async (from: string) => (from === "2026-10-15" ? days("2026-10-15", 7, 100, 40) : days(from, 7, 80, 50)))
  mocks.read.trafficTop.mockResolvedValue([{ key: "/apply", pageviews: 180, visitorDays: 150, days: 7 }])
})

describe("site_traffic", () => {
  it("is deferred and read only", () => {
    expect(siteTrafficTool).toMatchObject({ name: "site_traffic", deferred: true })
    expect(siteTrafficTool.writes).toBeFalsy()
  })

  it("defaults to the latest 7 stored days, day by day, in UTC", async () => {
    const data = JSON.parse((await run()).forModel)
    expect(data.range).toEqual({ from: "2026-10-15", to: "2026-10-21", days: 7, timeZone: "UTC" })
    expect(data.totals).toEqual({ days: 7, pageviews: 700, visitorDays: 280, visitorsPerDay: 40 })
    expect(data.days).toHaveLength(7)
    expect(data.notes).toMatch(/visitorsPerDay is the fair figure/)
  })

  it("compares with the same number of days before", async () => {
    const data = JSON.parse((await run({ compare: true })).forModel)
    expect(data.previous).toMatchObject({ range: { from: "2026-10-08", to: "2026-10-14" }, pageviews: 560, pageviewsChangePercent: 25, visitorsPerDayChangePercent: -20 })
  })

  it("gives the top groups of a dimension, or one page day by day", async () => {
    const top = JSON.parse((await run({ by: "path", match: "/apply" })).forModel)
    expect(top.groups).toEqual([{ key: "/apply", pageviews: 180, visitorDays: 150, days: 7 }])
    expect(mocks.read.trafficTop).toHaveBeenCalledWith("path", "2026-10-15", "2026-10-21", { match: "/apply", limit: 20 })

    mocks.read.trafficKeyDaily.mockResolvedValue([{ day: "2026-10-20", key: "/apply", pageviews: 60, visitors: 50 }])
    const daily = JSON.parse((await run({ by: "path", match: "/apply", daily: true })).forModel)
    expect(daily.rows).toEqual([{ day: "2026-10-20", key: "/apply", pageviews: 60, visitors: 50 }])
  })

  it("says which days aren't stored", async () => {
    const data = JSON.parse((await run({ from: "2026-09-01", to: "2026-09-30" })).forModel)
    expect(data.gap).toMatch(/Only 2026-09-23 to 2026-10-21 is stored/)
    expect(await run({ from: "2026-10-10", to: "2026-10-01" })).toMatchObject({ isError: true })
  })

  it("says it isn't connected when there are no snapshots and no connection", async () => {
    mocks.read.trafficCoverage.mockResolvedValue(null)
    mocks.status.mockResolvedValue({ state: "not_configured", lastSyncAt: null, missingEnv: ["VERCEL_ANALYTICS_TOKEN"], missingSettings: [] })
    expect((await run()).forModel).toMatch(/Site traffic is not set up yet/)
  })
})

describe("traffic sums", () => {
  it("average visitors per day rather than adding them up as people", () => {
    expect(totalsOf(days("2026-10-01", 3, 10, 5))).toEqual({ days: 3, pageviews: 30, visitorDays: 15, visitorsPerDay: 5 })
    expect(percentChange(125, 100)).toBe(25)
    expect(percentChange(5, 0)).toBeNull()
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28")
  })
})
