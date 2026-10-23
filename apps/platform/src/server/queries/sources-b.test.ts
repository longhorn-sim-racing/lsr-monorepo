import { describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ twitchViewerSample: { findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { sumDays, type AccountDay } from "./instagram-insights"
import { changeOver, streamViewers, toStreamSummary } from "./twitch"

const NOW = new Date("2026-10-22T23:30:00Z")
const row = (overrides: Partial<Parameters<typeof toStreamSummary>[0]> = {}) => ({
  id: "1",
  title: "Practice",
  gameName: null,
  startedAt: new Date("2026-10-22T21:00:00Z"),
  endedAt: new Date("2026-10-22T22:35:00Z"),
  peakViewers: 30,
  avgViewers: 21.234,
  vodId: "335921000",
  vodViews: 50,
  _count: { samples: 90 },
  ...overrides,
})

describe("stream summaries", () => {
  it("give the length, rounded average and VOD link", () => {
    expect(toStreamSummary(row(), NOW)).toMatchObject({ minutes: 95, sampled: true, peakViewers: 30, avgViewers: 21.2, vodUrl: "https://www.twitch.tv/videos/335921000" })
  })

  it("count a live stream's length so far", () => {
    expect(toStreamSummary(row({ endedAt: null }), NOW).minutes).toBe(150)
  })

  it("have no viewer numbers for a stream without samples (added from its VOD), rather than zero", () => {
    expect(toStreamSummary(row({ peakViewers: 0, avgViewers: null, _count: { samples: 0 } }), NOW)).toMatchObject({ sampled: false, peakViewers: null, avgViewers: null })
  })
})

describe("viewer timelines", () => {
  it("thin long streams to the peak of each stretch", async () => {
    const start = Date.parse("2026-10-22T21:00:00Z")
    db.twitchViewerSample.findMany.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ at: new Date(start + i * 60_000), viewers: i === 3 ? 99 : i })))
    expect(await streamViewers("1", 5)).toEqual([
      { at: new Date(start), viewers: 1 },
      { at: new Date(start + 2 * 60_000), viewers: 99 },
      { at: new Date(start + 4 * 60_000), viewers: 5 },
      { at: new Date(start + 6 * 60_000), viewers: 7 },
      { at: new Date(start + 8 * 60_000), viewers: 9 },
    ])
  })
})

describe("changeOver", () => {
  const day = (ymd: string, value: number) => ({ date: new Date(`${ymd}T00:00:00Z`), value })
  it("compares the latest value with the newest one at least that many days older", () => {
    const series = [day("2026-09-20", 380), day("2026-10-14", 400), day("2026-10-15", 402), day("2026-10-22", 412)]
    expect(changeOver(series, 7)).toBe(10)
    expect(changeOver(series, 30)).toBe(32)
    expect(changeOver(series, 60)).toBeNull()
    expect(changeOver([], 7)).toBeNull()
  })
})

describe("sumDays", () => {
  const day = (reach: number | null, follows: number | null = null): AccountDay => ({ date: new Date(), followers: 1, reach, views: reach === null ? null : reach * 2, accountsEngaged: null, totalInteractions: null, follows, unfollows: null })
  it("adds up the days that have numbers, and keeps null for a number no day had", () => {
    expect(sumDays([day(100, 2), day(150, 1), day(null)])).toEqual({ days: 2, reach: 250, views: 500, accountsEngaged: null, totalInteractions: null, follows: 3, unfollows: null })
    expect(sumDays([])).toMatchObject({ days: 0, reach: null })
  })
})
