import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes, type MountedFakes } from "../fakes/testing"
import { DISCORD_TIMEOUT_MS, DISCORD_USER_AGENT, DiscordApiError, DiscordRateLimitError, discordClient, queryString } from "./client"
import { FAKE_CHANNELS, FAKE_DISCORD } from "./fake/data"
import { discordFake } from "./fake/handlers"
import { DiscordRateLimiter, discordRoute } from "./rate-limit"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Calls one of the fake's /_fake hooks */
async function hook(fakes: MountedFakes, path: string, body: unknown) {
  await fetch(`${fakes.origin}/discord/_fake/${path}`, { method: "POST", body: JSON.stringify(body) })
}

/** A client with its own limiter, so one test's rate limits never reach another's */
function client(overrides: { token?: string; maxWaitMs?: number; limiter?: DiscordRateLimiter } = {}) {
  return discordClient({ token: overrides.token ?? FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: overrides.limiter ?? new DiscordRateLimiter(), maxWaitMs: overrides.maxWaitMs })
}

const apiCalls = (fakes: MountedFakes) => fakes.requests.filter((r) => r.path.startsWith("/api/"))

describe("discordRoute", () => {
  it("names a route with its ids as placeholders and its channel, guild or webhook as the major parameter", () => {
    expect(discordRoute("get", "/channels/1100000000000000010/messages/1300000000000000555?after=1")).toEqual({ route: "GET /channels/:id/messages/:id", major: "1100000000000000010" })
    expect(discordRoute("GET", "/guilds/1100000000000000000/members")).toEqual({ route: "GET /guilds/:id/members", major: "1100000000000000000" })
    expect(discordRoute("GET", "/users/@me")).toEqual({ route: "GET /users/@me", major: "" })
  })

  it("never keeps a webhook's token", () => {
    const route = discordRoute("POST", "/webhooks/1100000000000000077/aVerySecretWebhookToken_abc")
    expect(route).toEqual({ route: "POST /webhooks/:id/:token", major: "1100000000000000077" })
    expect(JSON.stringify(route)).not.toContain("aVerySecret")
  })
})

describe("queryString", () => {
  it("repeats the key for a list, skips empty values, and leaves out the ? when there's nothing", () => {
    expect(queryString({ channel_id: ["1", "2"], limit: 25, offset: undefined, after: null })).toBe("?channel_id=1&channel_id=2&limit=25")
    expect(queryString({})).toBe("")
  })
})

describe("the Discord client against its fake", () => {
  it("sends the bot token and Discord's User-Agent, and reads the server", async () => {
    const fakes = mountFakes([discordFake])
    const discord = client()
    const [guild, channels] = await Promise.all([discord.guild(), discord.channels()])
    expect(guild).toMatchObject({ id: FAKE_DISCORD.guildId, approximate_member_count: 41 })
    expect(channels.map((c) => c.name)).toContain("general")
    // The channel the bot can't see isn't listed
    expect(channels.some((c) => c.id === FAKE_CHANNELS.officers)).toBe(false)
    const request = apiCalls(fakes)[0]
    expect(request.headers.get("authorization")).toBe(`Bot ${FAKE_DISCORD.botToken}`)
    expect(request.headers.get("user-agent")).toBe(DISCORD_USER_AGENT)
    expect(fakes.requests.find((r) => r.path.endsWith("/guilds/" + FAKE_DISCORD.guildId))?.url).toContain("with_counts=true")
  })

  it("pages history newest first: after gives the oldest messages after the cursor, before the newest before it", async () => {
    mountFakes([discordFake])
    const discord = client()
    const latest = await discord.messages(FAKE_CHANNELS.general, { limit: 5 })
    expect(latest).toHaveLength(5)
    const ids = latest.map((m) => BigInt(m.id))
    expect([...ids].sort((a, b) => (a > b ? -1 : 1))).toEqual(ids)

    const older = await discord.messages(FAKE_CHANNELS.general, { before: latest[4].id, limit: 3 })
    expect(older.every((m) => BigInt(m.id) < BigInt(latest[4].id))).toBe(true)
    const newer = await discord.messages(FAKE_CHANNELS.general, { after: older[2].id, limit: 2 })
    // The two right after the cursor, still newest first
    expect(newer.map((m) => m.id)).toEqual([older[0].id, older[1].id])
  })

  it("fails with the status, Discord's code and the route, never the token or the ids", async () => {
    mountFakes([discordFake])
    const error = await client()
      .messages(FAKE_CHANNELS.officers)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DiscordApiError)
    expect(error).toMatchObject({ status: 403, code: 50001, route: "GET /channels/:id/messages" })
    expect((error as Error).message).toBe("Discord answered 403 (code 50001 Missing Access) on GET /channels/:id/messages")
    expect((error as Error).message).not.toContain(FAKE_DISCORD.botToken)
  })

  it("waits out a 429 for its retry_after and tries again", async () => {
    const fakes = mountFakes([discordFake])
    await hook(fakes, "rate-limit", { times: 2, retryAfter: 0.02, path: "/messages" })
    const page = await client().messages(FAKE_CHANNELS.general, { limit: 1 })
    expect(page).toHaveLength(1)
    expect(apiCalls(fakes).filter((r) => r.path.includes("/messages"))).toHaveLength(3)
  })

  it("gives up on a rate limit longer than it waits, without retrying", async () => {
    const fakes = mountFakes([discordFake])
    await hook(fakes, "rate-limit", { times: 1, retryAfter: 64.57, path: "/messages" })
    const error = await client({ maxWaitMs: 1_000 })
      .messages(FAKE_CHANNELS.general)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DiscordRateLimitError)
    expect(error).toMatchObject({ status: 429, retryAfterMs: 64_570 })
    expect(apiCalls(fakes)).toHaveLength(1)
  })

  it("holds every route after a global 429", async () => {
    const fakes = mountFakes([discordFake])
    const limiter = new DiscordRateLimiter()
    await hook(fakes, "rate-limit", { times: 1, retryAfter: 30, global: true, path: "/channels" })
    await expect(client({ limiter, maxWaitMs: 1_000 }).channels()).rejects.toBeInstanceOf(DiscordRateLimitError)
    // Another route on the same limiter waits too, so it fails before reaching Discord
    await expect(client({ limiter, maxWaitMs: 1_000 }).guild()).rejects.toBeInstanceOf(DiscordRateLimitError)
    expect(apiCalls(fakes)).toHaveLength(1)
  })

  it("never retries a 401, and stops calling Discord after one", async () => {
    const fakes = mountFakes([discordFake])
    const discord = client({ token: "not-the-token" })
    await expect(discord.channels()).rejects.toMatchObject({ status: 401, message: expect.stringContaining("the bot token was rejected") })
    await expect(discord.guild()).rejects.toMatchObject({ status: 401 })
    expect(apiCalls(fakes)).toHaveLength(1)
  })

  it("keeps its own timeout when the caller passes a signal too", async () => {
    mountFakes([discordFake])
    const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError")
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(timedOut))
    await expect(client().channels(new AbortController().signal)).rejects.toBe(timedOut)
    expect(timeout).toHaveBeenCalledWith(DISCORD_TIMEOUT_MS)
  })

  it("stops when the caller's signal aborts", async () => {
    const fakes = mountFakes([discordFake])
    const controller = new AbortController()
    controller.abort()
    await expect(client().channels(controller.signal)).rejects.toBeDefined()
    expect(apiCalls(fakes)).toHaveLength(0)
  })

  it("searches through a 202 (index not ready), flattening Discord's nested results", async () => {
    const fakes = mountFakes([discordFake])
    const result = await client().search({ content: "monza", channelIds: [FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat], limit: 5 })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.messages.length).toBeGreaterThan(0)
    expect(result.messages.every((m) => m.content.toLowerCase().includes("monza"))).toBe(true)
    expect(result.messages.every((m) => [FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat].includes(m.channel_id))).toBe(true)
    const searches = apiCalls(fakes).filter((r) => r.path.endsWith("/messages/search"))
    expect(searches).toHaveLength(2)
    expect(new URL(searches[1].url).searchParams.getAll("channel_id")).toEqual([FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat])
  })

  it("reports a search index that stays unready instead of waiting forever", async () => {
    const fakes = mountFakes([discordFake])
    await hook(fakes, "search", { ready: false, stuck: true })
    expect(await client().search({ content: "monza", channelIds: [FAKE_CHANNELS.general] })).toEqual({ status: "indexing" })
  })

  it("lists members in id order from the after cursor", async () => {
    mountFakes([discordFake])
    const first = await client().members({ limit: 10 })
    expect(first).toHaveLength(10)
    const next = await client().members({ after: first[9].user.id, limit: 1000 })
    expect(next).toHaveLength(41 - 10)
    expect(BigInt(next[0].user.id) > BigInt(first[9].user.id)).toBe(true)
  })
})

describe("DiscordRateLimiter", () => {
  it("holds a bucket with nothing left until it resets, per channel", () => {
    let now = 1_000
    const limiter = new DiscordRateLimiter(() => now)
    const general = discordRoute("GET", "/channels/1100000000000000010/messages")
    const other = discordRoute("GET", "/channels/1100000000000000011/messages")
    limiter.update(general, new Headers({ "x-ratelimit-bucket": "abc", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2.5" }))
    expect(limiter.delay(general)).toBe(2_500)
    expect(limiter.delay(other)).toBe(0)
    now += 2_500
    expect(limiter.delay(general)).toBe(0)
  })

  it("shares a bucket between routes Discord says share it", () => {
    let now = 0
    const limiter = new DiscordRateLimiter(() => now)
    const a = discordRoute("GET", "/channels/1100000000000000010/messages")
    const b = discordRoute("GET", "/channels/1100000000000000010/messages/1300000000000000555")
    limiter.update(a, new Headers({ "x-ratelimit-bucket": "shared", "x-ratelimit-remaining": "3" }))
    limiter.update(b, new Headers({ "x-ratelimit-bucket": "shared", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1" }))
    expect(limiter.delay(a)).toBe(1_000)
    now = 1_000
    expect(limiter.delay(a)).toBe(0)
  })
})
