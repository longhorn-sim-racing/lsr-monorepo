import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Both sources-b connectors against their fakes: what makes them configured, their smoke tests (which
// work while switched off) and the Connections page's lines
const store = vi.hoisted(() => ({ enabled: false, twitch: null as string | null }))
const access = vi.hoisted(() => ({ value: null as null | { token: string; userId: string | null; username: string | null; tokenExpiresAt: string | null } }))
const db = vi.hoisted(() => ({
  connectorState: { findUnique: vi.fn() },
  systemSetting: { findUnique: vi.fn(), update: vi.fn() },
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/instagram.service", () => ({ readInstagramAccess: vi.fn(async () => access.value) }))
vi.mock("./registry", () => ({ CONNECTORS: [], findConnector: () => undefined }))

import { mountFakes, type MountedFakes } from "./fakes/testing"
import { instagramInsightsConnector } from "./instagram/connector"
import { INSTAGRAM_FAKE, instagramFake } from "./instagram/fake/handlers"
import { runConnectorSmoke } from "./status"
import { twitchApi } from "./twitch/client"
import { twitchConnector } from "./twitch/connector"
import { TWITCH_FAKE, twitchFake } from "./twitch/fake/handlers"

let fakes: MountedFakes
const TWITCH_ENV = { TWITCH_CLIENT_ID: TWITCH_FAKE.clientId, TWITCH_CLIENT_SECRET: TWITCH_FAKE.clientSecret, TWITCH_BROADCASTER_ID: TWITCH_FAKE.broadcasterId, TWITCH_EVENTSUB_SECRET: TWITCH_FAKE.eventSubSecret }
const stubTwitchEnv = () => Object.entries(TWITCH_ENV).forEach(([key, value]) => vi.stubEnv(key, value))

/** Saves the club account's grant in the in-memory setting, from the fake's consent page */
async function connectClubAccount() {
  const api = twitchApi({ clientId: TWITCH_FAKE.clientId, clientSecret: TWITCH_FAKE.clientSecret })
  const consent = await fetch(api.authorizeUrl({ redirectUri: "https://site.test/cb", state: "s" }))
  const grant = await api.exchangeCode(new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? "", "https://site.test/cb")
  store.twitch = JSON.stringify({ user: { accessToken: grant.access_token, refreshToken: grant.refresh_token, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), login: TWITCH_FAKE.broadcasterLogin, userId: TWITCH_FAKE.broadcasterId, scopes: grant.scope, connectedAt: new Date().toISOString(), connectedById: "admin-1", validatedAt: new Date(Date.now() - 5 * 60_000).toISOString() } })
}

beforeEach(() => {
  store.enabled = false
  store.twitch = null
  access.value = null
  db.connectorState.findUnique.mockImplementation(async () => ({ id: "x", enabled: store.enabled, lastSyncAt: null, lastError: null, lastErrorAt: null, cursor: null, updatedAt: new Date() }))
  db.systemSetting.findUnique.mockImplementation(async () => (store.twitch === null ? null : { key: "twitch", value: store.twitch }))
  db.systemSetting.update.mockImplementation(async ({ data }: { data: { value: string } }) => {
    store.twitch = data.value
  })
  db.$executeRaw.mockImplementation(async () => {
    store.twitch ??= "{}"
    return 1
  })
  db.$queryRaw.mockImplementation(async () => [{ value: store.twitch }])
  db.$transaction.mockImplementation((fn: (tx: typeof db) => Promise<unknown>) => fn(db))
  fakes = mountFakes([twitchFake, instagramFake])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the Twitch connector", () => {
  it("has a client only with its env, the club account's grant, and its switch on", async () => {
    expect(twitchConnector.configured({})).toBe(false)
    expect(twitchConnector.configured(TWITCH_ENV)).toBe(true)
    stubTwitchEnv()
    expect(await twitchConnector.missingSettings!()).toEqual(["twitch"])
    store.enabled = true
    expect(await twitchConnector.client()).toBeNull()
    await connectClubAccount()
    expect(await twitchConnector.missingSettings!()).toEqual([])
    expect(await (await twitchConnector.client())?.liveStream()).toBeNull()
    store.enabled = false
    expect(await twitchConnector.client()).toBeNull()
  })

  it("passes its smoke test while switched off, before and after the club account is connected", async () => {
    stubTwitchEnv()
    expect(await runConnectorSmoke(twitchConnector)).toMatchObject({ ok: true, summary: `Read @${TWITCH_FAKE.broadcasterLogin}, offline; the club account isn't connected yet (Content → Streams)` })
    await connectClubAccount()
    expect(await runConnectorSmoke(twitchConnector)).toMatchObject({ ok: true, summary: `Read @${TWITCH_FAKE.broadcasterLogin}, offline; club account @${TWITCH_FAKE.broadcasterLogin} OK, ${TWITCH_FAKE.followers} followers` })
  })

  it("fails its smoke test on a broadcaster id Twitch doesn't know, or a wrong secret", async () => {
    stubTwitchEnv()
    vi.stubEnv("TWITCH_BROADCASTER_ID", "123")
    expect(await runConnectorSmoke(twitchConnector)).toMatchObject({ ok: false, summary: "Twitch has no user with the id in TWITCH_BROADCASTER_ID (123)." })
    // With no cached app token, so it mints one with the wrong secret
    store.twitch = null
    vi.stubEnv("TWITCH_CLIENT_SECRET", "a-wrong-client-secret")
    expect(await runConnectorSmoke(twitchConnector)).toMatchObject({ ok: false, summary: "TwitchApiError: Twitch answered 403 on /oauth2/token: invalid client secret" })
  })

  it("shows the club account on the Connections page, never a token", async () => {
    stubTwitchEnv()
    expect((await twitchConnector.status()).details).toEqual([{ label: "Club account", value: "Not connected: an admin connects it on Content → Streams" }])
    await connectClubAccount()
    const status = await twitchConnector.status()
    expect(status.details).toEqual([{ label: "Club account", value: `@${TWITCH_FAKE.broadcasterLogin}, checked 5 minutes ago` }])
    expect(JSON.stringify(status)).not.toMatch(/fakeuser|fakerefresh/)
    store.twitch = JSON.stringify({ ...JSON.parse(store.twitch!), reconnect: { reason: "Invalid refresh token", at: new Date().toISOString() } })
    expect((await twitchConnector.status()).details?.[0].value).toBe("Needs connecting again (Content → Streams): Invalid refresh token")
  })
})

describe("the Instagram insights connector", () => {
  it("needs the token saved in Admin → Instagram, and no env", async () => {
    expect(instagramInsightsConnector.requiredEnv).toEqual([])
    expect(await instagramInsightsConnector.missingSettings!()).toEqual(["instagram"])
    access.value = { token: INSTAGRAM_FAKE.token, userId: INSTAGRAM_FAKE.userId, username: INSTAGRAM_FAKE.username, tokenExpiresAt: "2026-12-01T12:00:00.000Z" }
    expect(await instagramInsightsConnector.missingSettings!()).toEqual([])
    expect(await instagramInsightsConnector.client()).toBeNull()
    store.enabled = true
    expect((await instagramInsightsConnector.client())?.userId).toBe(INSTAGRAM_FAKE.userId)
    expect((await instagramInsightsConnector.status()).details).toEqual([
      { label: "Account", value: `@${INSTAGRAM_FAKE.username}` },
      { label: "Token", value: "The feed sync's (Admin → Instagram), renewed weekly; runs out Dec 1 if renewing stops" },
    ])
  })

  it("passes its smoke test with the insights permission, and says which permission is missing without it", async () => {
    access.value = { token: INSTAGRAM_FAKE.token, userId: INSTAGRAM_FAKE.userId, username: INSTAGRAM_FAKE.username, tokenExpiresAt: null }
    expect(await runConnectorSmoke(instagramInsightsConnector)).toMatchObject({ ok: true, summary: expect.stringMatching(new RegExp(`^Read @${INSTAGRAM_FAKE.username}: ${INSTAGRAM_FAKE.followers} followers; yesterday's reach \\d+$`)) })
    access.value = { ...access.value, token: INSTAGRAM_FAKE.basicToken }
    expect(await runConnectorSmoke(instagramInsightsConnector)).toMatchObject({ ok: false, summary: expect.stringContaining("(code 10)") })
    expect(fakes.requests.every((r) => !r.url.includes("/v26.0/") || r.service === "instagram")).toBe(true)
  })
})
