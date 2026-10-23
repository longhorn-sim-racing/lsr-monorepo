import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FakeSourcesBDb } from "../sources-b-test-db"

const db = vi.hoisted(() => ({ current: null as FakeSourcesBDb | null }))
const state = vi.hoisted(() => ({ errors: [] as string[], syncs: 0 }))
const access = vi.hoisted(() => ({ value: null as null | { token: string; userId: string | null; username: string | null; tokenExpiresAt: string | null } }))
vi.mock("@/server/db", () => ({
  prisma: new Proxy({}, { get: (_target, table: string) => (db.current as Record<string, unknown> | null)?.[table] }),
}))
vi.mock("../state", () => ({
  connectorEnabled: vi.fn(async () => true),
  readConnectorState: vi.fn(async () => null),
  recordConnectorSync: vi.fn(async () => {
    state.syncs++
  }),
  recordConnectorError: vi.fn(async (_id: string, error: unknown) => {
    state.errors.push(error instanceof Error ? error.message : String(error))
    return ""
  }),
}))
vi.mock("@/server/services/instagram.service", () => ({ readInstagramAccess: vi.fn(async () => access.value) }))

import { mountFakes, type MountedFakes } from "../fakes/testing"
import { fakeSourcesBDb } from "../sources-b-test-db"
import { instagramInsightsClient, instagramInsightsConnector } from "./connector"
import { INSTAGRAM_FAKE, instagramFake } from "./fake/handlers"
import { postsDueForInsights, runInstagramAccountSnapshot, runInstagramPostInsights, withInstagramInsights } from "./sync"

const NOW = Date.parse("2026-10-22T11:50:00Z") // 6:50 AM Central
const DAY = 86_400_000
const HOUR = 3_600_000
const date = (ymd: string) => new Date(`${ymd}T00:00:00Z`)

let fakes: MountedFakes
let tables: FakeSourcesBDb

const client = async () => (await instagramInsightsClient())!
const fakeState = (body: unknown) => fetch(`${fakes.origin}/instagram/_fake/state`, { method: "POST", body: JSON.stringify(body) })
const post = (id: string, postedAt: number, insightsAt: number | null = null) => ({ id, permalink: `https://www.instagram.com/p/${id}/`, caption: null, mediaType: "IMAGE", postedAt: new Date(postedAt), insightsAt: insightsAt === null ? null : new Date(insightsAt) })

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  tables = fakeSourcesBDb()
  db.current = tables
  state.errors = []
  state.syncs = 0
  access.value = { token: INSTAGRAM_FAKE.token, userId: INSTAGRAM_FAKE.userId, username: INSTAGRAM_FAKE.username, tokenExpiresAt: new Date(NOW + 50 * DAY).toISOString() }
  fakes = mountFakes([instagramFake])
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the account snapshot", () => {
  it("saves today's follower count under the Central date, and no day before its first snapshot", async () => {
    const result = await runInstagramAccountSnapshot({ client: await client() })
    expect(tables.instagramAccountDaily.all()).toEqual([expect.objectContaining({ date: date("2026-10-22"), followers: INSTAGRAM_FAKE.followers, reach: null })])
    expect(result).toMatchObject({ counts: { followers: INSTAGRAM_FAKE.followers, days: 0 } })
    expect(result.summary).toContain("none yet")
    expect(state.syncs).toBe(1)
  })

  it("fills the last 3 days that have a snapshot, again on later runs as Instagram's late numbers come in", async () => {
    for (const ymd of ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]) await tables.instagramAccountDaily.createMany({ data: [{ date: date(ymd), followers: 1_270 }] })
    const result = await runInstagramAccountSnapshot({ client: await client() })
    expect(result.counts).toEqual({ followers: INSTAGRAM_FAKE.followers, days: 3 })
    expect(result.summary).toContain("Oct 19–Oct 21")
    const row = (ymd: string) => tables.instagramAccountDaily.rows.get(date(ymd).toISOString())!
    expect(row("2026-10-18").reach).toBeNull()
    for (const ymd of ["2026-10-19", "2026-10-20", "2026-10-21"]) expect(row(ymd)).toMatchObject({ followers: 1_270, reach: expect.any(Number), views: expect.any(Number), accountsEngaged: expect.any(Number), totalInteractions: expect.any(Number), follows: expect.any(Number), unfollows: expect.any(Number) })

    // Oct 21 ended under 48 hours ago, so its numbers weren't all in; two days on they are
    const early = row("2026-10-21").reach as number
    vi.setSystemTime(NOW + 2 * DAY)
    await tables.instagramAccountDaily.createMany({ data: [{ date: date("2026-10-23"), followers: 1_290 }] })
    await runInstagramAccountSnapshot({ client: await client() })
    expect(row("2026-10-21").reach).toBeGreaterThan(early)
    expect(row("2026-10-24").followers).toBe(INSTAGRAM_FAKE.followers)
  })

  it("reads the account id from /me when none was saved with the token", async () => {
    access.value = { ...access.value!, userId: null }
    await tables.instagramAccountDaily.createMany({ data: [{ date: date("2026-10-21"), followers: 1_270 }] })
    expect((await runInstagramAccountSnapshot({ client: await client() })).counts).toMatchObject({ days: 1 })
  })
})

describe("post insights", () => {
  it("picks the posts that are due: never read first, then by age (hourly, daily, monthly)", async () => {
    await tables.instagramPost.createMany({
      data: [
        post("new-unread", NOW - DAY),
        post("new-fresh", NOW - 2 * DAY, NOW - 10 * 60_000),
        post("new-stale", NOW - 3 * DAY, NOW - 2 * HOUR),
        post("mid-fresh", NOW - 10 * DAY, NOW - 5 * HOUR),
        post("mid-stale", NOW - 12 * DAY, NOW - 25 * HOUR),
        post("old-unread", NOW - 200 * DAY),
        post("old-fresh", NOW - 90 * DAY, NOW - 10 * DAY),
        post("old-stale", NOW - 120 * DAY, NOW - 40 * DAY),
      ],
    })
    expect((await postsDueForInsights(new Date(NOW))).map((p) => p.id)).toEqual(["new-unread", "old-unread", "new-stale", "mid-stale", "old-stale"])
    expect((await postsDueForInsights(new Date(NOW), 2)).map((p) => p.id)).toEqual(["new-unread", "old-unread"])
  })

  it("saves each due post's numbers, and marks one Instagram no longer has so it isn't asked for every hour", async () => {
    await tables.instagramPost.createMany({ data: [post("18012345678900010", NOW - DAY), post("18012345678900012", NOW - 8 * DAY), post("short-id", NOW - 2 * DAY)] })
    const result = await runInstagramPostInsights({ client: await client(), now: new Date(NOW) })
    expect(result).toMatchObject({ counts: { updated: 2, missing: 1 } })
    expect(tables.instagramPost.rows.get("18012345678900010")).toMatchObject({ reach: expect.any(Number), likes: expect.any(Number), saved: expect.any(Number), views: expect.any(Number), insightsAt: new Date(NOW) })
    expect(tables.instagramPost.rows.get("short-id")).toMatchObject({ reach: null, insightsAt: new Date(NOW) })
    expect(await runInstagramPostInsights({ client: await client(), now: new Date(NOW + 5 * 60_000) })).toMatchObject({ summary: "No posts due" })
  })

  it("skips a post with too few viewers to show numbers (code 10), without calling it a missing permission", async () => {
    await tables.instagramPost.createMany({ data: [post("18012345678900010", NOW - DAY), post("18012345678900011", NOW - 2 * DAY)] })
    await fakeState({ fewViewers: ["18012345678900010"] })
    const result = await runInstagramPostInsights({ client: await client(), now: new Date(NOW) })
    expect(result).toMatchObject({ counts: { updated: 1, missing: 1 } })
    expect(result.summary).toBe("Read the numbers of 1 post; Instagram had no numbers for 1 post (deleted, or too few viewers)")
    expect(tables.instagramPost.rows.get("18012345678900010")).toMatchObject({ reach: null, insightsAt: new Date(NOW) })
  })

  it("stops at the time limit", async () => {
    await tables.instagramPost.createMany({ data: [post("18012345678900010", NOW - DAY), post("18012345678900011", NOW - 2 * DAY)] })
    const controller = new AbortController()
    controller.abort()
    const log = vi.fn()
    expect(await runInstagramPostInsights({ client: await client(), signal: controller.signal, log })).toMatchObject({ counts: { updated: 0 } })
    expect(log).toHaveBeenCalledWith("Stopped at the time limit; the next run continues.")
  })
})

describe("withInstagramInsights", () => {
  it("skips without a client (switched off, or no token)", async () => {
    vi.spyOn(instagramInsightsConnector, "client").mockResolvedValue(null)
    expect(await withInstagramInsights(vi.fn())).toMatchObject({ status: "skipped" })
  })

  it("explains a missing insights permission on the connector and in the run log", async () => {
    access.value = { ...access.value!, token: INSTAGRAM_FAKE.basicToken }
    await tables.instagramAccountDaily.createMany({ data: [{ date: date("2026-10-21"), followers: 1_270 }] })
    vi.spyOn(instagramInsightsConnector, "client").mockImplementation(() => instagramInsightsClient())
    await expect(withInstagramInsights((c) => runInstagramAccountSnapshot({ client: c }))).rejects.toThrow(/doesn't have the insights permission/)
    expect(state.errors[0]).toMatch(/^The Instagram token doesn't have the insights permission \(instagram_business_manage_insights\)/)
  })

  it("explains a dead token", async () => {
    await fakeState({ expire: true })
    vi.spyOn(instagramInsightsConnector, "client").mockImplementation(() => instagramInsightsClient())
    await expect(withInstagramInsights((c) => runInstagramAccountSnapshot({ client: c }))).rejects.toThrow(/expired or was revoked: paste a new token in Admin → Instagram/)
  })
})
