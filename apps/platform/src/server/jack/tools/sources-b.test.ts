import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { ConnectorStatus } from "@/server/connectors/types"
import type { StreamSummary } from "@/server/queries/twitch"
import type { PostWithInsights } from "@/server/queries/instagram-insights"

const twitchQueries = vi.hoisted(() => ({ twitchOverview: vi.fn(), listStreams: vi.fn(), findStream: vi.fn(), streamViewers: vi.fn(), followerSeries: vi.fn() }))
const instagramQueries = vi.hoisted(() => ({ instagramInsightsOverview: vi.fn(), instagramAccountDays: vi.fn(), listPostInsights: vi.fn(), POST_SORTS: ["recent", "reach", "views", "likes", "comments", "saved", "shares"] }))
const statuses = vi.hoisted(() => ({ twitch: null as unknown, instagram: null as unknown }))
vi.mock("@/server/queries/twitch", () => twitchQueries)
vi.mock("@/server/queries/instagram-insights", () => instagramQueries)
vi.mock("@/server/connectors/twitch/connector", () => ({ twitchConnector: { label: "Twitch", status: async () => statuses.twitch } }))
vi.mock("@/server/connectors/instagram/connector", () => ({ instagramInsightsConnector: { label: "Instagram insights", status: async () => statuses.instagram } }))

import { instagramInsightsTool } from "./instagram-insights"
import { TOOLS } from "./registry/sources-b"
import { sourceStatus } from "./source-status"
import { twitchStatsTool } from "./twitch-stats"
import type { JackToolContext } from "./types"

const NOW = Date.parse("2026-10-22T23:30:00Z")
const ctx: JackToolContext = { roomId: "jack-eval-room", actor: { userId: "u1", displayName: "Gray" } }

function status(state: ConnectorStatus["state"], overrides: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return { id: "x", label: "X", configured: state !== "not_configured", missingEnv: [], missingSettings: [], enabled: state === "connected" || state === "error", state, lastSyncAt: "2026-10-22T23:29:00.000Z", lastError: null, lastErrorAt: null, hasSmoke: true, ...overrides }
}

const stream = (overrides: Partial<StreamSummary> = {}): StreamSummary => ({
  id: "40952121001",
  title: "Lone Star Cup S3 Round 5",
  gameName: "Assetto Corsa Competizione",
  startedAt: new Date("2026-10-20T00:00:00Z"),
  endedAt: new Date("2026-10-20T02:30:00Z"),
  minutes: 150,
  sampled: true,
  peakViewers: 61,
  avgViewers: 42.5,
  vodId: "335921000",
  vodViews: 120,
  vodUrl: "https://www.twitch.tv/videos/335921000",
  ...overrides,
})

const post = (overrides: Partial<PostWithInsights> = {}): PostWithInsights => ({
  id: "18012345678900010",
  permalink: "https://www.instagram.com/p/FAKE900010/",
  caption: "GM 2 recap: 38 drivers",
  mediaType: "IMAGE",
  postedAt: new Date("2026-10-21T17:00:00Z"),
  hidden: false,
  reach: 812,
  likes: 90,
  comments: 6,
  saved: 14,
  shares: 3,
  views: 1_700,
  insightsAt: new Date("2026-10-22T23:25:00Z"),
  ...overrides,
})

const model = (forModel: string) => JSON.parse(forModel) as Record<string, unknown>

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  statuses.twitch = status("connected")
  statuses.instagram = status("connected")
  return () => vi.useRealTimers()
})

describe("sourceStatus", () => {
  const connector = (s: ConnectorStatus) => ({ id: "twitch", label: "Twitch", requiredEnv: [], configured: () => true, enabled: async () => true, client: async () => null, status: async () => s })

  it("says nothing extra when connected, and how fresh otherwise", async () => {
    expect(await sourceStatus(connector(status("connected")))).toEqual({ connected: true, lastSync: "Thu 2026-10-22 18:29 CT" })
    expect((await sourceStatus(connector(status("off")))).note).toBe("Twitch isn't connected: it's switched off on System → Connections, so the stored numbers stop at its last sync (Thu 2026-10-22 18:29 CT).")
    expect((await sourceStatus(connector(status("not_configured", { lastSyncAt: null })))).note).toBe("Twitch isn't connected yet (set up on System → Connections), and nothing has been synced yet.")
    expect(await sourceStatus(connector(status("error", { lastErrorAt: "2026-10-22T23:00:00.000Z" })))).toMatchObject({ connected: true, note: expect.stringContaining("last sync failed (Thu 2026-10-22 18:00 CT)") })
  })
})

describe("twitch_stats", () => {
  it("leads with live now, the last stream, the last 30 days and followers", async () => {
    twitchQueries.twitchOverview.mockResolvedValue({
      live: { ...stream({ id: "live-1", endedAt: null, minutes: 30, startedAt: new Date(NOW - 30 * 60_000) }), viewersNow: 23, lastSampleAt: new Date(NOW - 60_000) },
      lastStream: stream(),
      last30: { streams: 6, hours: 11.5, peakViewers: 88, avgViewers: 37.2 },
      followers: { latest: { date: new Date("2026-10-22T00:00:00Z"), followers: 412 }, change7: 4, change30: 19 },
    })
    const result = await twitchStatsTool.run(twitchStatsTool.input.parse({}), ctx)
    const data = model(result.forModel)
    expect(data.live).toMatchObject({ id: "live-1", ended: "live now", viewersNow: 23 })
    expect(data.lastStream).toMatchObject({ started: "Mon 2026-10-19 19:00 CT", length: "2h 30m", peakViewers: 61, avgViewers: 42.5, vodUrl: "https://www.twitch.tv/videos/335921000" })
    expect(data.followers).toEqual({ latest: 412, asOf: "2026-10-22", changeLast7Days: 4, changeLast30Days: 19 })
    expect(data.dataNotes).toEqual(expect.arrayContaining([expect.stringContaining("not unique viewers")]))
    expect(result.label).toBe("Looked at Twitch (live now, 23 viewers)")
    expect(result.displays?.[0]).toMatchObject({ kind: "stats", items: [{ label: "Live now", value: 23 }, { label: "Followers", value: 412, hint: "+19 in 30 days" }, expect.anything(), expect.anything()] })
  })

  it("says Twitch isn't connected when nothing is stored", async () => {
    statuses.twitch = status("not_configured", { lastSyncAt: null })
    twitchQueries.twitchOverview.mockResolvedValue({ live: null, lastStream: null, last30: { streams: 0, hours: 0, peakViewers: null, avgViewers: null }, followers: { latest: null, change7: null, change30: null } })
    const result = await twitchStatsTool.run(twitchStatsTool.input.parse({}), ctx)
    expect(model(result.forModel).connection).toMatchObject({ connected: false, note: expect.stringContaining("isn't connected yet") })
    expect(result.displays).toContainEqual({ kind: "note", text: expect.stringContaining("isn't connected yet") })
  })

  it("lists streams in a Central date range, marking ones whose viewers weren't counted", async () => {
    twitchQueries.listStreams.mockResolvedValue([stream(), stream({ id: "old", sampled: false, peakViewers: null, avgViewers: null })])
    const result = await twitchStatsTool.run(twitchStatsTool.input.parse({ view: "streams", from: "2026-10-01", to: "2026-10-22" }), ctx)
    expect(twitchQueries.listStreams).toHaveBeenCalledWith({ from: new Date("2026-10-01T05:00:00Z"), to: new Date("2026-10-23T05:00:00Z"), limit: 30, now: new Date(NOW) })
    expect((model(result.forModel).streams as unknown[])[1]).toMatchObject({ id: "old", sampled: false, peakViewers: null })
    expect(result.displays?.[0]).toMatchObject({ kind: "table", columns: ["Started", "Title", "Length", "Peak", "Average", "VOD views"] })
  })

  it("refuses a backwards range", async () => {
    const result = await twitchStatsTool.run(twitchStatsTool.input.parse({ view: "streams", from: "2026-10-22", to: "2026-10-01" }), ctx)
    expect(result).toMatchObject({ isError: true, forModel: "The range starts (2026-10-22) after it ends (2026-10-01)." })
  })

  it("shows one stream minute by minute, or says its viewers weren't counted", async () => {
    twitchQueries.findStream.mockResolvedValueOnce(stream())
    twitchQueries.streamViewers.mockResolvedValue([{ at: new Date("2026-10-20T00:01:00Z"), viewers: 12 }, { at: new Date("2026-10-20T00:02:00Z"), viewers: 15 }])
    const result = await twitchStatsTool.run(twitchStatsTool.input.parse({ view: "stream" }), ctx)
    expect(model(result.forModel).viewersByMinute).toEqual([{ at: "Mon 2026-10-19 19:01 CT", viewers: 12 }, { at: "Mon 2026-10-19 19:02 CT", viewers: 15 }])
    expect(result.displays?.[0]).toMatchObject({ kind: "chart", chart: { type: "line", rows: [{ time: "7:01 PM", viewers: 12 }, { time: "7:02 PM", viewers: 15 }] } })

    twitchQueries.findStream.mockResolvedValueOnce(stream({ sampled: false }))
    expect((await twitchStatsTool.run(twitchStatsTool.input.parse({ view: "stream", streamId: "old" }), ctx)).displays).toEqual([{ kind: "note", text: expect.stringContaining("weren't counted") }])

    twitchQueries.findStream.mockResolvedValueOnce(null)
    expect(await twitchStatsTool.run(twitchStatsTool.input.parse({ view: "stream", streamId: "nope" }), ctx)).toMatchObject({ isError: true })
  })

  it("charts followers by day", async () => {
    twitchQueries.followerSeries.mockResolvedValue([{ date: new Date("2026-10-21T00:00:00Z"), followers: 410 }, { date: new Date("2026-10-22T00:00:00Z"), followers: 412 }])
    const result = await twitchStatsTool.run(twitchStatsTool.input.parse({ view: "followers", from: "2026-10-01" }), ctx)
    expect(twitchQueries.followerSeries).toHaveBeenCalledWith({ from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-22T00:00:00Z") })
    expect(result.label).toBe("Looked at Twitch followers (412 now)")
    expect(result.displays?.[0]).toMatchObject({ kind: "chart", chart: { rows: [{ date: "2026-10-21", followers: 410 }, { date: "2026-10-22", followers: 412 }] } })
  })
})

describe("instagram_insights", () => {
  const week = (reach: number | null) => ({ days: 7, reach, views: reach && reach * 3, accountsEngaged: 40, totalInteractions: 120, follows: 21, unfollows: 4 })

  it("leads with followers, this week against last, and the most reached posts", async () => {
    instagramQueries.instagramInsightsOverview.mockResolvedValue({
      followers: { latest: { date: new Date("2026-10-22T00:00:00Z"), followers: 1_284 }, change7: 12, change30: 40 },
      week: week(1_500),
      previousWeek: week(1_200),
      lastDayWithNumbers: new Date("2026-10-21T00:00:00Z"),
      topPosts: [post()],
      postsUpdatedAt: new Date("2026-10-22T23:25:00Z"),
    })
    const result = await instagramInsightsTool.run(instagramInsightsTool.input.parse({}), ctx)
    const data = model(result.forModel)
    expect(data.last7Days).toEqual({ daysWithNumbers: 7, reach: 1_500, views: 4_500, accountsEngaged: 40, interactions: 120, follows: 21, unfollows: 4 })
    expect(data.topPostsLast30Days).toEqual([expect.objectContaining({ id: "18012345678900010", saves: 14, link: "https://www.instagram.com/p/FAKE900010/", numbersAsOf: "Thu 2026-10-22 18:25 CT" })])
    expect(result.displays?.[0]).toMatchObject({ kind: "stats", items: [{ label: "Followers", value: 1_284 }, { label: "Reach (7 days)", value: 1_500, hint: "+25% on the week before" }, expect.anything(), expect.anything()] })
  })

  it("lists posts by the sort asked for, in a date range", async () => {
    instagramQueries.listPostInsights.mockResolvedValue([post(), post({ id: "2", reach: null, insightsAt: null })])
    const result = await instagramInsightsTool.run(instagramInsightsTool.input.parse({ view: "posts", sort: "saved", from: "2026-09-01" }), ctx)
    expect(instagramQueries.listPostInsights).toHaveBeenCalledWith({ from: new Date("2026-09-01T05:00:00Z"), to: new Date("2026-10-23T05:00:00Z"), sort: "saved", match: undefined, limit: 20 })
    expect((model(result.forModel).posts as unknown[])[1]).toMatchObject({ id: "2", reach: null, numbersAsOf: "not read yet" })
  })

  it("finds one post by its caption, or says how to look", async () => {
    instagramQueries.listPostInsights.mockResolvedValueOnce([post()])
    const found = await instagramInsightsTool.run(instagramInsightsTool.input.parse({ view: "post", match: "GM 2" }), ctx)
    expect(instagramQueries.listPostInsights).toHaveBeenCalledWith({ id: undefined, match: "GM 2", limit: 5 })
    expect(found.label).toBe("Looked at an Instagram post (Wed Oct 21, 12:00 PM)")
    expect(await instagramInsightsTool.run(instagramInsightsTool.input.parse({ view: "post" }), ctx)).toMatchObject({ isError: true })
    instagramQueries.listPostInsights.mockResolvedValueOnce([])
    expect(await instagramInsightsTool.run(instagramInsightsTool.input.parse({ view: "post", match: "nothing like it" }), ctx)).toMatchObject({ isError: true, forModel: expect.stringContaining("Try view posts") })
  })

  it("gives the account's numbers by day, charting reach and views", async () => {
    instagramQueries.instagramAccountDays.mockResolvedValue([
      { date: new Date("2026-10-20T00:00:00Z"), followers: 1_280, reach: 200, views: 600, accountsEngaged: 30, totalInteractions: 70, follows: 3, unfollows: 1 },
      { date: new Date("2026-10-21T00:00:00Z"), followers: 1_282, reach: 220, views: 640, accountsEngaged: 31, totalInteractions: 72, follows: 2, unfollows: 0 },
      { date: new Date("2026-10-22T00:00:00Z"), followers: 1_284, reach: null, views: null, accountsEngaged: null, totalInteractions: null, follows: null, unfollows: null },
    ])
    const result = await instagramInsightsTool.run(instagramInsightsTool.input.parse({ view: "daily" }), ctx)
    expect((model(result.forModel).days as unknown[]).length).toBe(3)
    expect(result.displays?.[0]).toMatchObject({ kind: "chart", chart: { series: [{ key: "reach" }, { key: "views" }], rows: [{ date: "2026-10-20" }, { date: "2026-10-21" }] } })
  })
})

describe("the sources-b tools", () => {
  it("are deferred, named with their service, and keep their definitions within the track's budget", () => {
    expect(TOOLS.map((t) => [t.name, t.deferred])).toEqual([["twitch_stats", true], ["instagram_insights", true]])
    const size = TOOLS.reduce((n, tool) => n + JSON.stringify({ name: tool.name, description: tool.description, input_schema: z.toJSONSchema(tool.input) }).length, 0)
    expect(size).toBeLessThanOrEqual(6_000)
  })
})
