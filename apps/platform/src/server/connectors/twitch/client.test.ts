import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes, type MountedFakes } from "../fakes/testing"
import { parseTwitchDuration, TWITCH_TIMEOUT_MS, TwitchApiError, twitchApi } from "./client"
import { twitchClient } from "./connector"
import { TWITCH_FAKE, twitchFake } from "./fake/handlers"
import { memoryTwitchTokens, TwitchReconnectError } from "./tokens"

// The real Twitch client against its fake, through the fetch interceptor
vi.mock("@/server/db", () => ({ prisma: {} }))

const ENV = { TWITCH_CLIENT_ID: TWITCH_FAKE.clientId, TWITCH_CLIENT_SECRET: TWITCH_FAKE.clientSecret, TWITCH_BROADCASTER_ID: TWITCH_FAKE.broadcasterId }
const CREDS = { clientId: TWITCH_FAKE.clientId, clientSecret: TWITCH_FAKE.clientSecret }
const REDIRECT = "https://www.longhornsimracing.org/api/admin/twitch/callback"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Env for a client built after mountFakes (which stubs JACK_FAKES on process.env) */
const env = () => ({ ...process.env, ...ENV })

const hook = (fakes: MountedFakes, path: string, body: unknown = {}) => fetch(`${fakes.origin}/twitch/_fake/${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json())

/** The club account's grant, the way the connect flow gets it: the consent page's redirect, then the code */
async function clubGrant(api: ReturnType<typeof twitchApi>) {
  const consent = await fetch(api.authorizeUrl({ redirectUri: REDIRECT, state: "state-1" }), { redirect: "manual" })
  const back = new URL(consent.headers.get("location") ?? "")
  expect(back.searchParams.get("state")).toBe("state-1")
  return api.exchangeCode(back.searchParams.get("code") ?? "", REDIRECT)
}

describe("the Twitch API client against the fake", () => {
  it("mints an app token with the client's credentials, in the body", async () => {
    const fakes = mountFakes([twitchFake])
    const grant = await twitchApi(CREDS, env()).mintAppToken()
    expect(grant).toMatchObject({ token_type: "bearer", expires_in: 5_011_271 })
    const call = fakes.requests[0]
    expect(`${call.method} ${call.path}`).toBe("POST /oauth2/token")
    expect(call.url).not.toContain(TWITCH_FAKE.clientSecret)
    expect(new URLSearchParams(call.body).get("grant_type")).toBe("client_credentials")
  })

  it("names the status and Twitch's message on an error, never the secret", async () => {
    mountFakes([twitchFake])
    const error = await twitchApi({ ...CREDS, clientSecret: "a-wrong-secret-value" }, env()).mintAppToken().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TwitchApiError)
    expect(error).toMatchObject({ status: 403, message: "Twitch answered 403 on /oauth2/token: invalid client secret" })
    expect(String((error as Error).message)).not.toContain("a-wrong-secret-value")
  })

  it("builds the consent link with the one scope, the state and force_verify", () => {
    mountFakes([twitchFake])
    const link = new URL(twitchApi(CREDS, env()).authorizeUrl({ redirectUri: REDIRECT, state: "abc" }))
    expect(link.pathname).toBe("/twitch/oauth2/authorize")
    expect(Object.fromEntries(link.searchParams)).toEqual({ client_id: TWITCH_FAKE.clientId, redirect_uri: REDIRECT, response_type: "code", scope: "moderator:read:followers", state: "abc", force_verify: "true" })
  })

  it("swaps a code for tokens once, rotates the refresh token, and validates and revokes", async () => {
    mountFakes([twitchFake])
    const api = twitchApi(CREDS, env())
    const first = await clubGrant(api)
    expect(first).toMatchObject({ scope: ["moderator:read:followers"], token_type: "bearer" })
    expect(await api.validate(first.access_token)).toMatchObject({ user_id: TWITCH_FAKE.broadcasterId, login: TWITCH_FAKE.broadcasterLogin, scopes: ["moderator:read:followers"] })

    const second = await api.refreshUserToken(first.refresh_token!)
    expect(second.refresh_token).not.toBe(first.refresh_token)
    await expect(api.refreshUserToken(first.refresh_token!)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Invalid refresh token") })

    await api.revoke(second.access_token)
    expect(await api.validate(second.access_token)).toBeNull()
    // Revoking a token Twitch doesn't know isn't an error
    await expect(api.revoke("never-issued")).resolves.toBeUndefined()
  })

  it("retries a 503 once, and reports a 429 with when its limit resets", async () => {
    const fakes = mountFakes([twitchFake])
    const client = twitchClient(env(), memoryTwitchTokens())
    await hook(fakes, "fail", { status: 503 })
    expect(await client.liveStream()).toBeNull()

    await hook(fakes, "fail", { status: 503, times: 2 })
    await expect(client.liveStream()).rejects.toMatchObject({ status: 503 })

    await hook(fakes, "fail", { status: 429 })
    const limited = (await client.liveStream().catch((e: unknown) => e)) as TwitchApiError
    expect(limited.status).toBe(429)
    expect(limited.retryAt).toBeGreaterThan(Date.now())
  })

  it("keeps its timeout when the caller passes a signal too", async () => {
    mountFakes([twitchFake])
    const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError")
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(timedOut))
    await expect(twitchApi(CREDS, env()).mintAppToken(new AbortController().signal)).rejects.toBe(timedOut)
    expect(timeout).toHaveBeenCalledWith(TWITCH_TIMEOUT_MS)
  })
})

describe("the club channel through twitchClient", () => {
  it("reads the account, live status, channel and past broadcasts with an app token and Client-Id", async () => {
    const fakes = mountFakes([twitchFake])
    const client = twitchClient(env(), memoryTwitchTokens())
    expect(await client.user()).toEqual({ id: TWITCH_FAKE.broadcasterId, login: TWITCH_FAKE.broadcasterLogin, displayName: TWITCH_FAKE.broadcasterName })
    expect(await client.liveStream()).toBeNull()

    await hook(fakes, "live", { title: "GM 3 watch party", gameName: "iRacing", viewers: 20 })
    const live = await client.liveStream()
    expect(live).toMatchObject({ title: "GM 3 watch party", gameName: "iRacing" })
    expect(live?.viewers).toBeGreaterThanOrEqual(16)
    expect(await client.channel()).toEqual({ title: "GM 3 watch party", gameName: "iRacing" })

    const helixCall = fakes.requests.find((r) => r.path === "/helix/streams")!
    expect(helixCall.headers.get("client-id")).toBe(TWITCH_FAKE.clientId)
    expect(helixCall.headers.get("authorization")).toMatch(/^Bearer fakeapp/)
    // One app token for all of them
    expect(fakes.requests.filter((r) => r.path === "/oauth2/token")).toHaveLength(1)
  })

  it("pages through past broadcasts up to the cap, reading their durations", async () => {
    const fakes = mountFakes([twitchFake])
    const client = twitchClient(env(), memoryTwitchTokens())
    const all = await client.archiveVideos()
    expect(all).toHaveLength(8)
    expect(all[0]).toMatchObject({ streamId: "40952120000", seconds: 9_000, views: 61, url: "https://www.twitch.tv/videos/335921000" })
    expect(all.map((v) => v.createdAt.getTime())).toEqual([...all.map((v) => v.createdAt.getTime())].sort((a, b) => b - a))

    const before = fakes.requests.length
    const three = await client.archiveVideos({ max: 3 })
    expect(three.map((v) => v.id)).toEqual(all.slice(0, 3).map((v) => v.id))
    expect(new URL(fakes.requests[before].url).searchParams.get("first")).toBe("3")
  })

  it("mints a new app token when Twitch stops accepting the cached one", async () => {
    const fakes = mountFakes([twitchFake])
    const client = twitchClient(env(), memoryTwitchTokens())
    await client.liveStream()
    await hook(fakes, "tokens/expire", { kind: "app" })
    expect(await client.liveStream()).toBeNull()
    expect(fakes.requests.filter((r) => r.path === "/oauth2/token")).toHaveLength(2)
  })

  it("reads the follower total with the club account's token, refreshing it when it runs out", async () => {
    const fakes = mountFakes([twitchFake])
    const grant = await clubGrant(twitchApi(CREDS, env()))
    const client = twitchClient(env(), memoryTwitchTokens({ refreshToken: grant.refresh_token }))
    expect(await client.followerTotal()).toBe(TWITCH_FAKE.followers)
    const call = fakes.requests.find((r) => r.path === "/helix/channels/followers")!
    expect(new URL(call.url).searchParams.get("first")).toBe("1")
    expect(call.headers.get("authorization")).toMatch(/^Bearer fakeuser/)

    await hook(fakes, "tokens/expire", { kind: "user" })
    await hook(fakes, "followers", { total: 415 })
    expect(await client.followerTotal()).toBe(415)
  })

  it("checks the club account: right user, right scope; refreshes a token Twitch won't validate", async () => {
    const fakes = mountFakes([twitchFake])
    const grant = await clubGrant(twitchApi(CREDS, env()))
    const client = twitchClient(env(), memoryTwitchTokens({ refreshToken: grant.refresh_token }))
    expect(await client.checkClubAccount()).toMatchObject({ login: TWITCH_FAKE.broadcasterLogin, scopes: ["moderator:read:followers"] })
    await hook(fakes, "tokens/expire", { kind: "user" })
    expect(await client.checkClubAccount()).toMatchObject({ login: TWITCH_FAKE.broadcasterLogin })
  })

  it("refuses a grant that isn't the club channel's", async () => {
    const fakes = mountFakes([twitchFake])
    await hook(fakes, "authorize", { as: "other" })
    const grant = await clubGrant(twitchApi(CREDS, env()))
    const client = twitchClient(env(), memoryTwitchTokens({ refreshToken: grant.refresh_token }))
    await expect(client.checkClubAccount()).rejects.toBeInstanceOf(TwitchReconnectError)
  })
})

describe("parseTwitchDuration", () => {
  it("reads Get Videos' h/m/s durations", () => {
    expect(parseTwitchDuration("3h21m4s")).toBe(12_064)
    expect(parseTwitchDuration("3m21s")).toBe(201)
    expect(parseTwitchDuration("45s")).toBe(45)
    expect(parseTwitchDuration("2h")).toBe(7_200)
    expect(parseTwitchDuration("")).toBe(0)
    expect(parseTwitchDuration("PT3H")).toBe(0)
  })
})
