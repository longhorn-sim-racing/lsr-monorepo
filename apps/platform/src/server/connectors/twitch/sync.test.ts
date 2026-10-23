import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FakeSourcesBDb } from "../sources-b-test-db"

const db = vi.hoisted(() => ({ current: null as FakeSourcesBDb | null }))
const state = vi.hoisted(() => ({ syncs: 0, errors: [] as string[] }))
vi.mock("@/server/db", () => ({
  prisma: new Proxy({}, { get: (_target, table: string) => (db.current as Record<string, unknown> | null)?.[table] }),
}))
// The cursor lives in the in-memory ConnectorState row: the live check also writes it there directly (a run that wrote nothing isn't a sync)
vi.mock("../state", () => ({
  readConnectorState: vi.fn(async (id: string) => db.current?.connectorState.rows.get(id) ?? null),
  recordConnectorSync: vi.fn(async (id: string, options: { cursor?: unknown } = {}) => {
    state.syncs++
    await db.current?.connectorState.upsert({ where: { id }, update: { lastSyncAt: new Date(), ...(options.cursor !== undefined ? { cursor: options.cursor } : {}) }, create: { id, lastSyncAt: new Date(), cursor: options.cursor ?? null } })
  }),
  recordConnectorError: vi.fn(async (_id: string, error: unknown) => {
    state.errors.push(error instanceof Error ? error.message : String(error))
    return ""
  }),
  connectorEnabled: vi.fn(async () => true),
}))

import { mountFakes, type MountedFakes } from "../fakes/testing"
import { fakeSourcesBDb } from "../sources-b-test-db"
import { twitchApi } from "./client"
import { twitchClient, twitchConnector } from "./connector"
import { TWITCH_FAKE, twitchFake } from "./fake/handlers"
import { closeStreams, currentLiveStream, latestStreamWentLive, recordStreamOnline, recordVideos, streamsWentLiveSince } from "./streams"
import { runTwitchDailySnapshot, runTwitchLiveCheck, runTwitchTokenCheck, withTwitch } from "./sync"
import { memoryTwitchTokens } from "./tokens"

const NOW = Date.parse("2026-10-22T23:30:00Z") // 6:30 PM Central
const MINUTE = 60_000
const ENV = { TWITCH_CLIENT_ID: TWITCH_FAKE.clientId, TWITCH_CLIENT_SECRET: TWITCH_FAKE.clientSecret, TWITCH_BROADCASTER_ID: TWITCH_FAKE.broadcasterId }

let fakes: MountedFakes
let tables: FakeSourcesBDb

const hook = (path: string, body: unknown = {}) => fetch(`${fakes.origin}/twitch/_fake/${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json())
const client = (refreshToken?: string) => twitchClient({ ...process.env, ...ENV }, memoryTwitchTokens({ refreshToken }))
const at = (ms: number) => vi.setSystemTime(ms)
const stream = (id: string) => tables.twitchStream.rows.get(id) as Record<string, unknown> | undefined
const cursor = () => tables.connectorState.rows.get("twitch")?.cursor
/** One live check a minute, from NOW + `from` minutes, `count` times; their summaries */
async function checksEveryMinute(from: number, count: number) {
  const summaries: string[] = []
  for (let m = from; m < from + count; m++) {
    at(NOW + m * MINUTE)
    summaries.push((await runTwitchLiveCheck({ client: client() })).summary)
  }
  return summaries
}

/** The club account's refresh token, from the fake's consent page */
async function clubRefreshToken() {
  const api = twitchApi({ clientId: TWITCH_FAKE.clientId, clientSecret: TWITCH_FAKE.clientSecret }, { ...process.env, ...ENV })
  const consent = await fetch(api.authorizeUrl({ redirectUri: "https://site.test/cb", state: "s" }))
  const grant = await api.exchangeCode(new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? "", "https://site.test/cb")
  return grant.refresh_token
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  tables = fakeSourcesBDb()
  db.current = tables
  state.syncs = 0
  state.errors = []
  fakes = mountFakes([twitchFake])
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the live check", () => {
  it("says offline when nothing is live or open, without counting as a sync (an earlier job's error stays visible)", async () => {
    expect(await runTwitchLiveCheck({ client: client() })).toEqual({ summary: "Offline" })
    expect(cursor()).toEqual({ closedByCheck: [] })
    expect(state.syncs).toBe(0)
    expect(tables.connectorState.rows.get("twitch")?.lastSyncAt).toBeNull()
  })

  it("opens a stream whose stream.online never came, and samples viewers once a minute", async () => {
    const { stream: live } = await hook("live", { title: "GM 3 watch party", gameName: "iRacing", viewers: 30, notify: false })
    const first = await runTwitchLiveCheck({ client: client() })
    expect(first.summary).toMatch(/^Live: \d+ viewers \(opened the stream/)
    expect(stream(live.id)).toMatchObject({ title: "GM 3 watch party", gameName: "iRacing", endedAt: null, startedAt: new Date(live.started_at) })

    // A second check in the same minute doesn't add a sample
    await runTwitchLiveCheck({ client: client() })
    expect(tables.twitchViewerSample.all()).toHaveLength(1)

    at(NOW + MINUTE)
    await runTwitchLiveCheck({ client: client() })
    const samples = tables.twitchViewerSample.all().map((s) => s.viewers as number)
    expect(samples).toHaveLength(2)
    expect(stream(live.id)).toMatchObject({ peakViewers: Math.max(...samples), avgViewers: (samples[0] + samples[1]) / 2 })
    expect(await currentLiveStream()).toMatchObject({ id: live.id, title: "GM 3 watch party" })
  })

  it("closes a stream only after 3 checks in a row miss it, at its last sample", async () => {
    const { stream: live } = await hook("live", { viewers: 25, notify: false })
    await runTwitchLiveCheck({ client: client() })
    await hook("offline", { notify: false })

    at(NOW + MINUTE)
    expect((await runTwitchLiveCheck({ client: client() })).summary).toContain("1 of 3")
    at(NOW + 2 * MINUTE)
    expect((await runTwitchLiveCheck({ client: client() })).summary).toContain("2 of 3")
    expect(stream(live.id)?.endedAt).toBeNull()
    at(NOW + 3 * MINUTE)
    expect(await runTwitchLiveCheck({ client: client() })).toMatchObject({ counts: { closed: 1 } })
    expect(stream(live.id)).toMatchObject({ endedAt: new Date(Math.floor(NOW / MINUTE) * MINUTE) })
    expect(cursor()).toEqual({ closedByCheck: [live.id] })
  })

  it("isn't fooled by one empty answer (Get Streams' lag and flapping)", async () => {
    const { stream: live } = await hook("live", { viewers: 25, notify: false })
    await runTwitchLiveCheck({ client: client() })
    await hook("streams", { flap: true })
    at(NOW + MINUTE)
    await runTwitchLiveCheck({ client: client() })
    expect(cursor()).toMatchObject({ misses: 1 })
    at(NOW + 2 * MINUTE)
    await runTwitchLiveCheck({ client: client() })
    expect(cursor()).toEqual({ closedByCheck: [] })
    expect(stream(live.id)?.endedAt).toBeNull()
    expect(tables.twitchViewerSample.all()).toHaveLength(2)
  })

  it("waits for Get Streams to list a stream stream.online opened, however many minutes it lags at first", async () => {
    // The webhook opens the row at go-live; Get Streams stays empty for the next 4 calls
    const { stream: live } = await hook("live", { viewers: 25, notify: false, lagCalls: 4 })
    await recordStreamOnline({ id: live.id, startedAt: new Date(live.started_at) })
    const waiting = await checksEveryMinute(0, 4)
    expect(waiting.every((s) => s.includes("doesn't list the stream that just went live yet"))).toBe(true)
    expect(stream(live.id)?.endedAt).toBeNull()
    expect(cursor()).toEqual({ closedByCheck: [] })

    const [sampled] = await checksEveryMinute(4, 1)
    expect(sampled).toMatch(/^Live: \d+ viewers$/)
    expect(stream(live.id)).toMatchObject({ endedAt: null, avgViewers: expect.any(Number) })
    expect(tables.twitchViewerSample.all()).toHaveLength(1)
    expect((await currentLiveStream())?.id).toBe(live.id)
  })

  it("closes a stream Get Streams never listed only after its start-up allowance and 3 misses, and reopens it if Get Streams lists it after all", async () => {
    const { stream: live } = await hook("live", { viewers: 25, notify: false, lagCalls: 14 })
    await recordStreamOnline({ id: live.id, startedAt: new Date(live.started_at) })
    // Minutes 0–9: the allowance; 10 and 11: misses 1 and 2; 12: the third closes it
    const summaries = await checksEveryMinute(0, 13)
    expect(summaries.slice(10, 12)).toEqual([expect.stringContaining("1 of 3"), expect.stringContaining("2 of 3")])
    expect(stream(live.id)?.endedAt).toEqual(new Date(NOW + 10 * MINUTE))
    expect(cursor()).toEqual({ closedByCheck: [live.id] })

    // One more empty answer (the 14th), then Get Streams lists it: the stream is reopened and sampled
    const [stillClosed, reopened] = await checksEveryMinute(13, 2)
    expect(stillClosed).toBe("Offline")
    expect(reopened).toContain("reopened the stream")
    expect(stream(live.id)).toMatchObject({ endedAt: null, avgViewers: expect.any(Number) })
    expect(cursor()).toEqual({ closedByCheck: [] })
    expect((await currentLiveStream())?.id).toBe(live.id)
  })

  it("closes an open stream it can't see once the start-up allowance is over, even without samples", async () => {
    await recordStreamOnline({ id: "gone", startedAt: new Date(NOW - 30 * MINUTE) })
    await checksEveryMinute(0, 3)
    expect(stream("gone")?.endedAt).toEqual(new Date(NOW))
  })

  it("never reopens a stream stream.offline closed, while Get Streams still lists it", async () => {
    const { stream: live } = await hook("live", { viewers: 25, notify: false })
    await recordStreamOnline({ id: live.id, startedAt: new Date(live.started_at) })
    await closeStreams({ endedAt: new Date(NOW), id: live.id })
    expect((await runTwitchLiveCheck({ client: client() })).summary).toContain("already closed")
    expect(stream(live.id)?.endedAt).toEqual(new Date(NOW))
    expect(tables.twitchViewerSample.all()).toHaveLength(0)
    expect(state.syncs).toBe(0)
  })

  it("reports an open stream as live only while something has seen it in the last 15 minutes", async () => {
    // The connector was switched off mid-stream: the last sample is 20 minutes old
    await recordStreamOnline({ id: "left-open", startedAt: new Date(NOW - 60 * MINUTE) })
    await tables.twitchViewerSample.createMany({ data: [{ streamId: "left-open", at: new Date(NOW - 20 * MINUTE), viewers: 8 }] })
    expect(await currentLiveStream()).toBeNull()
    expect((await currentLiveStream(new Date(NOW - 10 * MINUTE)))?.id).toBe("left-open")
    // Just opened by stream.online, nothing sampled yet: live from its start
    await recordStreamOnline({ id: "new", startedAt: new Date(NOW - 2 * MINUTE) })
    expect((await currentLiveStream())?.id).toBe("new")
  })

  it("closes the old stream when a reconnect starts a new one", async () => {
    const { stream: first } = await hook("live", { viewers: 25, notify: false })
    await runTwitchLiveCheck({ client: client() })
    at(NOW + 2 * MINUTE)
    const { stream: second } = await hook("live", { viewers: 20, notify: false })
    await runTwitchLiveCheck({ client: client() })
    expect(stream(first.id)?.endedAt).toEqual(new Date(second.started_at))
    expect(stream(second.id)?.endedAt).toBeNull()
    expect(await streamsWentLiveSince(new Date(NOW - MINUTE))).toHaveLength(2)
    expect((await latestStreamWentLive())?.id).toBe(second.id)
  })
})

describe("the daily snapshot", () => {
  it("keeps past broadcasts' VOD views, adding rows for broadcasts it hadn't seen, and today's follower total", async () => {
    const result = await runTwitchDailySnapshot({ client: client(await clubRefreshToken()) })
    expect(result).toMatchObject({ counts: { videos: 8, updated: 0, added: 8, followers: TWITCH_FAKE.followers } })
    const backfilled = stream("40952120002")
    expect(backfilled).toMatchObject({ title: "Lone Star Cup S3 Round 4 @ Monza: live broadcast", vodId: "335921002", vodViews: 88, peakViewers: 0, avgViewers: null })
    expect((backfilled?.endedAt as Date).getTime() - (backfilled?.startedAt as Date).getTime()).toBe(3 * 3_600_000)
    // The Central date: 6:30 PM on Oct 22
    expect(tables.twitchChannelDaily.all()).toEqual([{ date: new Date("2026-10-22T00:00:00Z"), followers: TWITCH_FAKE.followers }])
  })

  it("is safe to run again: views move, nothing doubles", async () => {
    // One client: the refresh token rotates on its first use
    const club = client(await clubRefreshToken())
    await runTwitchDailySnapshot({ client: club })
    await hook("videos", { views: 5 })
    await hook("followers", { total: 420 })
    expect(await runTwitchDailySnapshot({ client: club })).toMatchObject({ counts: { updated: 8, added: 0, followers: 420 } })
    expect(tables.twitchStream.all()).toHaveLength(8)
    expect(stream("40952120000")?.vodViews).toBe(66)
    expect(tables.twitchChannelDaily.all()).toHaveLength(1)
  })

  it("fills in the VOD of a stream it sampled live, keeping its viewer numbers", async () => {
    const { stream: live } = await hook("live", { viewers: 40, notify: false })
    await runTwitchLiveCheck({ client: client() })
    await hook("offline", { notify: false })
    await closeStreams({ endedAt: new Date(NOW + MINUTE), id: live.id })
    await runTwitchDailySnapshot({ client: client(await clubRefreshToken()) })
    expect(stream(live.id)).toMatchObject({ vodId: expect.any(String), vodViews: expect.any(Number), peakViewers: expect.any(Number) })
    expect(stream(live.id)?.peakViewers).toBeGreaterThan(0)
  })

  it("doesn't add a closed row for a broadcast that may still be live (the live check opens those)", async () => {
    const video = (id: string, streamId: string, createdAt: number, seconds: number) => ({ id, streamId, title: "Practice", createdAt: new Date(createdAt), seconds, views: 3, url: `https://www.twitch.tv/videos/${id}` })
    const result = await recordVideos(
      [
        // Get Streams lists it as live now
        video("v-live", "s-live", NOW - 3 * 3_600_000, 3_600),
        // Its archive reaches to 2 minutes ago: it may be live while Get Streams lags
        video("v-recent", "s-recent", NOW - 30 * MINUTE, 28 * 60),
        video("v-old", "s-old", NOW - 86_400_000, 3_600),
      ],
      new Date(NOW),
      { liveStreamId: "s-live" },
    )
    expect(result).toEqual({ updated: 0, added: 1, deferred: 2 })
    expect([...tables.twitchStream.rows.keys()]).toEqual(["s-old"])

    // Once it has a row (opened live), the VOD only fills in its numbers
    await recordStreamOnline({ id: "s-live", startedAt: new Date(NOW - 3 * 3_600_000) })
    expect(await recordVideos([video("v-live", "s-live", NOW - 3 * 3_600_000, 3_600)], new Date(NOW), { liveStreamId: "s-live" })).toEqual({ updated: 1, added: 0, deferred: 0 })
    expect(stream("s-live")).toMatchObject({ endedAt: null, vodId: "v-live" })
  })

  it("leaves the archive of the broadcast that's live now to the live check (no closed row for a live stream)", async () => {
    // Started an hour ago, both signals missed so far; Twitch already lists its archive
    const { stream: live } = await hook("live", { viewers: 9, notify: false, startedAt: new Date(NOW - 60 * MINUTE).toISOString() })
    const result = await runTwitchDailySnapshot({ client: client(await clubRefreshToken()) })
    expect(result.counts).toMatchObject({ videos: 9, added: 8, deferred: 1 })
    expect(stream(live.id)).toBeUndefined()
    expect((await runTwitchLiveCheck({ client: client() })).summary).toContain("opened the stream")
    expect(stream(live.id)).toMatchObject({ endedAt: null })
  })
})

describe("the token check", () => {
  it("validates the club account and prunes EventSub ids older than 2 days", async () => {
    await tables.twitchEventSubMessage.createMany({ data: [{ id: "old", type: "notification", receivedAt: new Date(NOW - 3 * 86_400_000) }, { id: "new", type: "notification", receivedAt: new Date(NOW - 3_600_000) }] })
    const result = await runTwitchTokenCheck({ client: client(await clubRefreshToken()) })
    expect(result.summary).toContain(`@${TWITCH_FAKE.broadcasterLogin} is valid`)
    expect(result.counts).toEqual({ prunedMessages: 1 })
    expect([...tables.twitchEventSubMessage.rows.keys()]).toEqual(["new"])
  })
})

describe("withTwitch", () => {
  it("skips while the connector has no client", async () => {
    vi.spyOn(twitchConnector, "client").mockResolvedValue(null)
    const run = vi.fn()
    expect(await withTwitch(run)).toMatchObject({ status: "skipped" })
    expect(run).not.toHaveBeenCalled()
  })

  it("records a failure on the connector and rethrows it for the run log", async () => {
    vi.spyOn(twitchConnector, "client").mockResolvedValue(client())
    await hook("fail", { status: 503, times: 2 })
    await expect(withTwitch((c) => runTwitchLiveCheck({ client: c }))).rejects.toMatchObject({ status: 503 })
    expect(state.errors).toEqual(["Twitch answered 503 on /streams: Service Unavailable"])
  })
})
