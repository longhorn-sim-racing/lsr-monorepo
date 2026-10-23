import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes, type MountedFakes } from "../fakes/testing"
import { INSTAGRAM_FAKE, instagramFake } from "./fake/handlers"
import { InstagramGraphError, instagramGraph, type InstagramGraph } from "./graph"
import { dayRange, followsAndUnfollows, insightValue, instagramInsights } from "./insights"

// The real Graph client and insights calls against the Instagram fake
afterEach(() => {
  vi.unstubAllGlobals()
})

const fakeState = (fakes: MountedFakes, body: unknown) => fetch(`${fakes.origin}/instagram/_fake/state`, { method: "POST", body: JSON.stringify(body) })
const OCT_21 = new Date("2026-10-21T00:00:00Z")

describe("the Graph client", () => {
  it("calls the pinned version with the token in the query on GET, and as a Bearer header on POST", async () => {
    const fakes = mountFakes([instagramFake])
    const graph = instagramGraph(INSTAGRAM_FAKE.token)
    expect(await graph.get("/me", { fields: "user_id,username" })).toEqual({ id: INSTAGRAM_FAKE.appScopedId, user_id: INSTAGRAM_FAKE.userId, username: INSTAGRAM_FAKE.username })
    expect(fakes.requests[0].path).toBe("/v26.0/me")
    expect(new URL(fakes.requests[0].url).searchParams.get("access_token")).toBe(INSTAGRAM_FAKE.token)

    await graph.post("/me/media", { caption: "x" }).catch(() => undefined)
    expect(fakes.requests[1].headers.get("authorization")).toBe(`Bearer ${INSTAGRAM_FAKE.token}`)
    expect(fakes.requests[1].url).not.toContain(INSTAGRAM_FAKE.token)
  })

  it("follows INSTAGRAM_GRAPH_URL when fakes are off, like the feed sync", () => {
    const seen: string[] = []
    vi.stubGlobal("fetch", async (input: string) => {
      seen.push(input)
      return Response.json({ id: "1" })
    })
    void instagramGraph("t", { INSTAGRAM_GRAPH_URL: "http://127.0.0.1:4555/" }).get("/me")
    expect(seen[0]).toMatch(/^http:\/\/127\.0\.0\.1:4555\/v26\.0\/me\?/)
  })

  it("names Meta's code and subcode on an error, never the token or the query", async () => {
    const fakes = mountFakes([instagramFake])
    await fakeState(fakes, { passwordChanged: true })
    const error = (await instagramGraph(INSTAGRAM_FAKE.token).get("/me", { fields: "username" }).catch((e: unknown) => e)) as InstagramGraphError
    expect(error).toBeInstanceOf(InstagramGraphError)
    expect(error).toMatchObject({ status: 400, code: 190, subcode: 460, path: "/me", expiredToken: true })
    expect(error.message).toMatch(/^Instagram answered 400 \(code 190\/460\) on \/me: /)
    expect(error.message).not.toContain(INSTAGRAM_FAKE.token)
    expect(error.message).not.toContain("access_token")
  })
})

describe("insights against the fake", () => {
  it("reads the profile's follower count and its professional account id", async () => {
    mountFakes([instagramFake])
    expect(await instagramInsights(instagramGraph(INSTAGRAM_FAKE.token)).profile()).toEqual({ userId: INSTAGRAM_FAKE.userId, username: INSTAGRAM_FAKE.username, followers: INSTAGRAM_FAKE.followers, follows: 211, mediaCount: 10 })
  })

  it("reads a Central day's account totals with follows and unfollows, one breakdown per call", async () => {
    const fakes = mountFakes([instagramFake])
    const day = await instagramInsights(instagramGraph(INSTAGRAM_FAKE.token)).accountDay(INSTAGRAM_FAKE.userId, OCT_21)
    expect(Object.values(day).every((v) => typeof v === "number" && v >= 0)).toBe(true)
    const [totals, follows] = fakes.requests.map((r) => new URL(r.url).searchParams)
    expect(totals.get("metric")).toBe("reach,accounts_engaged,views,total_interactions")
    expect([totals.get("period"), totals.get("metric_type"), totals.get("breakdown")]).toEqual(["day", "total_value", null])
    expect([totals.get("since"), totals.get("until")]).toEqual([String(dayRange(OCT_21).since), String(dayRange(OCT_21).until)])
    expect([follows.get("metric"), follows.get("breakdown")]).toEqual(["follows_and_unfollows", "follow_type"])
  })

  it("has no follows or unfollows under 100 followers (empty data is null, not 0)", async () => {
    const fakes = mountFakes([instagramFake])
    await fakeState(fakes, { followers: 80 })
    const day = await instagramInsights(instagramGraph(INSTAGRAM_FAKE.token)).accountDay(INSTAGRAM_FAKE.userId, OCT_21)
    expect(day).toMatchObject({ follows: null, unfollows: null })
    expect(day.reach).toEqual(expect.any(Number))
  })

  it("fails with code 10 when the token lacks the insights permission (today's basic-only token)", async () => {
    mountFakes([instagramFake])
    await expect(instagramInsights(instagramGraph(INSTAGRAM_FAKE.basicToken)).accountDay(INSTAGRAM_FAKE.userId, OCT_21)).rejects.toMatchObject({ code: 10, missingPermission: true })
  })

  it("reads a post's lifetime numbers, for photos, albums and reels", async () => {
    mountFakes([instagramFake])
    const insights = instagramInsights(instagramGraph(INSTAGRAM_FAKE.token))
    for (const id of ["18012345678900010", "18012345678900011", "18012345678900012"]) {
      const post = await insights.post(id)
      expect(Object.keys(post).sort()).toEqual(["comments", "likes", "reach", "saved", "shares", "views"])
      expect(Object.values(post).every((v) => typeof v === "number")).toBe(true)
    }
  })

  it("tells a deleted post (100/33) from a refused metric", async () => {
    const fakes = mountFakes([instagramFake])
    await fakeState(fakes, { deleteMedia: ["18012345678900010"] })
    await expect(instagramInsights(instagramGraph(INSTAGRAM_FAKE.token)).post("18012345678900010")).rejects.toMatchObject({ code: 100, subcode: 33 })
    // One call, not one per metric
    expect(fakes.requests.filter((r) => r.path.includes("/insights"))).toHaveLength(1)
  })
})

describe("insights when Instagram refuses a metric", () => {
  /** A Graph that refuses any call naming `refused` with error 100 */
  function refusing(refused: string, answer: (metric: string) => unknown[]): InstagramGraph & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      async get<T>(_path: string, params: Record<string, string | number | undefined> = {}) {
        const metric = String(params.metric)
        calls.push(metric)
        if (metric.split(",").includes(refused)) throw new InstagramGraphError(400, "/x/insights", 100, null, "unsupported metric")
        return { data: metric.split(",").flatMap(answer) } as T
      },
      post: async () => {
        throw new Error("unused")
      },
    }
  }

  it("asks for each metric alone and leaves the refused one null", async () => {
    const graph = refusing("views", (m) => [{ name: m, values: [{ value: 7 }] }])
    const post = await instagramInsights(graph).post("123456789012345678")
    expect(post).toEqual({ reach: 7, likes: 7, comments: 7, saved: 7, shares: 7, views: null })
    expect(graph.calls).toEqual(["reach,likes,comments,saved,shares,views", "reach", "likes", "comments", "saved", "shares", "views"])
  })
})

describe("reading insight values", () => {
  it("takes total_value for account metrics and values[0] for lifetime ones; missing is null", () => {
    const items = [{ name: "reach", total_value: { value: 224 } }, { name: "saved", values: [{ value: 14 }] }, { name: "views", total_value: {} }]
    expect([insightValue(items, "reach"), insightValue(items, "saved"), insightValue(items, "views"), insightValue(items, "likes")]).toEqual([224, 14, null, null])
  })

  it("splits follows_and_unfollows by follow_type", () => {
    const item = { name: "follows_and_unfollows", total_value: { value: 9, breakdowns: [{ dimension_keys: ["follow_type"], results: [{ dimension_values: ["FOLLOWER"], value: 7 }, { dimension_values: ["NON_FOLLOWER"], value: 2 }] }] } }
    expect(followsAndUnfollows([item])).toEqual({ follows: 7, unfollows: 2 })
    expect(followsAndUnfollows([{ name: "follows_and_unfollows", total_value: { value: 0, breakdowns: [{ dimension_keys: ["follow_type"], results: [{ dimension_values: ["FOLLOWER"], value: 3 }] }] } }])).toEqual({ follows: 3, unfollows: 0 })
    expect(followsAndUnfollows([])).toEqual({ follows: null, unfollows: null })
  })

  it("turns a Central day into inclusive Unix bounds, 25 hours on the day the clocks go back", () => {
    expect(dayRange(OCT_21)).toEqual({ since: Date.parse("2026-10-21T05:00:00Z") / 1000, until: Date.parse("2026-10-22T05:00:00Z") / 1000 - 1 })
    const fallBack = dayRange(new Date("2026-11-01T00:00:00Z"))
    expect(fallBack.until - fallBack.since + 1).toBe(25 * 3600)
  })
})
