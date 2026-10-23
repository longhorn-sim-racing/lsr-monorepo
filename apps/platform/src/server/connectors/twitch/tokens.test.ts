import { beforeEach, describe, expect, it, vi } from "vitest"
import { TwitchApiError, type TwitchApi } from "./client"

// SystemSetting "twitch" in memory; $transaction runs one at a time, like the row lock
const store = vi.hoisted(() => ({ value: null as string | null }))
const db = vi.hoisted(() => ({
  systemSetting: { findUnique: vi.fn(), update: vi.fn() },
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { clearEventSubRevoked, forgetTwitchClubGrant, recordEventSubRevoked, saveTwitchClubGrant, settingsTwitchTokens, TwitchReconnectError, twitchAccountView, type TwitchSettings } from "./tokens"

const NOW = Date.parse("2026-10-22T18:00:00Z")
const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

const settings = () => JSON.parse(store.value ?? "{}") as TwitchSettings
const save = (value: TwitchSettings) => {
  store.value = JSON.stringify(value)
}

const grant = (overrides: Partial<NonNullable<TwitchSettings["user"]>> = {}) => ({
  accessToken: "user-access-1",
  refreshToken: "refresh-1",
  expiresAt: iso(NOW + 3 * HOUR),
  login: "lsr_club",
  userId: "141981764",
  scopes: ["moderator:read:followers"],
  connectedAt: iso(NOW - 24 * HOUR),
  connectedById: "admin-1",
  ...overrides,
})

function fakeApi() {
  let minted = 0
  let refreshed = 0
  return {
    mintAppToken: vi.fn(async () => ({ access_token: `app-${++minted}`, expires_in: 5_000_000, token_type: "bearer" })),
    refreshUserToken: vi.fn(async (refreshToken: string) => {
      // A beat of network time, so concurrent callers really overlap
      await new Promise((resolve) => setTimeout(resolve, 5))
      refreshed++
      return { access_token: `user-access-r${refreshed}`, refresh_token: `${refreshToken}-r${refreshed}`, expires_in: 14_000, scope: ["moderator:read:followers"], token_type: "bearer" }
    }),
  }
}
const asApi = (api: ReturnType<typeof fakeApi>) => api as unknown as TwitchApi

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  store.value = null
  db.systemSetting.findUnique.mockImplementation(async () => (store.value === null ? null : { key: "twitch", value: store.value }))
  db.systemSetting.update.mockImplementation(async ({ data }: { data: { value: string } }) => {
    store.value = data.value
  })
  db.$executeRaw.mockImplementation(async () => {
    store.value ??= "{}"
    return 1
  })
  db.$queryRaw.mockImplementation(async () => [{ value: store.value }])
  let chain: Promise<unknown> = Promise.resolve()
  db.$transaction.mockImplementation((fn: (tx: typeof db) => Promise<unknown>) => {
    const run = chain.then(() => fn(db))
    chain = run.catch(() => undefined)
    return run
  })
  return () => vi.useRealTimers()
})

describe("the app token", () => {
  it("is minted once and cached until it's near its end or Twitch refuses it", async () => {
    const api = fakeApi()
    expect(await settingsTwitchTokens.app(asApi(api))).toBe("app-1")
    expect(await settingsTwitchTokens.app(asApi(api))).toBe("app-1")
    expect(api.mintAppToken).toHaveBeenCalledTimes(1)
    expect(settings().app).toEqual({ accessToken: "app-1", expiresAt: iso(NOW + 5_000_000_000) })

    expect(await settingsTwitchTokens.app(asApi(api), { failed: "app-1" })).toBe("app-2")
    vi.setSystemTime(NOW + 5_000_000_000 - 60_000)
    expect(await settingsTwitchTokens.app(asApi(api))).toBe("app-3")
  })

  it("keeps the club account's grant when it saves an app token", async () => {
    save({ user: grant() })
    await settingsTwitchTokens.app(asApi(fakeApi()))
    expect(settings().user).toEqual(grant())
  })
})

describe("the club account's token", () => {
  it("says to connect the account when there's no grant", async () => {
    await expect(settingsTwitchTokens.user(asApi(fakeApi()))).rejects.toBeInstanceOf(TwitchReconnectError)
  })

  it("uses the stored token while it's fresh, and refreshes it near its end, keeping the rotated refresh token", async () => {
    save({ user: grant() })
    const api = fakeApi()
    expect(await settingsTwitchTokens.user(asApi(api))).toBe("user-access-1")
    expect(api.refreshUserToken).not.toHaveBeenCalled()

    vi.setSystemTime(NOW + 3 * HOUR - 60_000)
    expect(await settingsTwitchTokens.user(asApi(api))).toBe("user-access-r1")
    expect(api.refreshUserToken).toHaveBeenCalledWith("refresh-1", undefined)
    expect(settings().user).toMatchObject({ accessToken: "user-access-r1", refreshToken: "refresh-1-r1", refreshedAt: iso(NOW + 3 * HOUR - 60_000) })
  })

  it("refreshes once when several calls find it expired at the same time (the row lock and the re-read)", async () => {
    save({ user: grant({ expiresAt: iso(NOW - 1) }) })
    const api = fakeApi()
    const tokens = await Promise.all(Array.from({ length: 5 }, () => settingsTwitchTokens.user(asApi(api))))
    expect(api.refreshUserToken).toHaveBeenCalledTimes(1)
    expect(new Set(tokens)).toEqual(new Set(["user-access-r1"]))
    expect(settings().user?.refreshToken).toBe("refresh-1-r1")
  })

  it("refreshes a token Twitch answered 401 to, even when it looks fresh, unless another call already did", async () => {
    save({ user: grant() })
    const api = fakeApi()
    expect(await settingsTwitchTokens.user(asApi(api), { failed: "user-access-1" })).toBe("user-access-r1")
    // A second caller that saw the same 401 gets the new token without refreshing again
    expect(await settingsTwitchTokens.user(asApi(api), { failed: "user-access-1" })).toBe("user-access-r1")
    expect(api.refreshUserToken).toHaveBeenCalledTimes(1)
  })

  it("marks the account for reconnecting when Twitch refuses the refresh token, and stops calling Twitch", async () => {
    save({ user: grant({ expiresAt: iso(NOW - 1) }) })
    const api = fakeApi()
    api.refreshUserToken.mockRejectedValueOnce(new TwitchApiError(400, "/oauth2/token", "Invalid refresh token"))
    await expect(settingsTwitchTokens.user(asApi(api))).rejects.toThrow(/connected again on Content → Streams/)
    expect(settings().reconnect).toEqual({ reason: "Twitch answered 400 on /oauth2/token: Invalid refresh token", at: iso(NOW) })
    // The grant stays (an admin reconnects over it)
    expect(settings().user?.refreshToken).toBe("refresh-1")

    await expect(settingsTwitchTokens.user(asApi(api))).rejects.toBeInstanceOf(TwitchReconnectError)
    expect(api.refreshUserToken).toHaveBeenCalledTimes(1)
  })

  it("passes on a refresh that failed for a while (a 503) without marking anything", async () => {
    save({ user: grant({ expiresAt: iso(NOW - 1) }) })
    const api = fakeApi()
    api.refreshUserToken.mockRejectedValueOnce(new TwitchApiError(503, "/oauth2/token"))
    await expect(settingsTwitchTokens.user(asApi(api))).rejects.toMatchObject({ status: 503 })
    expect(settings().reconnect).toBeUndefined()
  })

  it("records validation", async () => {
    save({ user: grant() })
    await settingsTwitchTokens.validated!(new Date(NOW))
    expect(settings().user?.validatedAt).toBe(iso(NOW))
  })
})

describe("connecting and disconnecting", () => {
  it("saves a new grant and clears a reconnect mark", async () => {
    save({ app: { accessToken: "app-1", expiresAt: iso(NOW + HOUR) }, user: grant(), reconnect: { reason: "refused", at: iso(NOW) } })
    await saveTwitchClubGrant(grant({ accessToken: "fresh", refreshToken: "fresh-refresh" }))
    expect(settings()).toEqual({ app: { accessToken: "app-1", expiresAt: iso(NOW + HOUR) }, user: grant({ accessToken: "fresh", refreshToken: "fresh-refresh" }) })
  })

  it("forgets the grant and hands back its tokens to revoke", async () => {
    save({ app: { accessToken: "app-1", expiresAt: iso(NOW + HOUR) }, user: grant(), reconnect: { reason: "refused", at: iso(NOW) } })
    expect(await forgetTwitchClubGrant()).toEqual({ accessToken: "user-access-1", refreshToken: "refresh-1" })
    expect(settings()).toEqual({ app: { accessToken: "app-1", expiresAt: iso(NOW + HOUR) } })
    expect(await forgetTwitchClubGrant()).toBeNull()
  })

  it("shows pages the account, never a token", () => {
    const view = twitchAccountView({ app: { accessToken: "app-1", expiresAt: iso(NOW) }, user: grant({ validatedAt: iso(NOW) }) })
    expect(view).toEqual({ connected: true, login: "lsr_club", scopes: ["moderator:read:followers"], connectedAt: iso(NOW - 24 * HOUR), validatedAt: iso(NOW), refreshedAt: null, reconnect: null, webhooksRevoked: [] })
    expect(JSON.stringify(view)).not.toMatch(/access|refresh-1|app-1/)
  })
})

describe("revoked webhooks", () => {
  it("are kept one per type next to the grant, and forgotten by type without touching the rest", async () => {
    save({ user: grant() })
    await recordEventSubRevoked({ type: "stream.online", status: "notification_failures_exceeded", at: iso(NOW - HOUR) })
    await recordEventSubRevoked({ type: "stream.offline", status: "authorization_revoked", at: iso(NOW - HOUR) })
    await recordEventSubRevoked({ type: "stream.online", status: "authorization_revoked", at: iso(NOW) })
    expect(twitchAccountView(settings()).webhooksRevoked).toEqual([
      { type: "stream.offline", status: "authorization_revoked", at: iso(NOW - HOUR) },
      { type: "stream.online", status: "authorization_revoked", at: iso(NOW) },
    ])
    expect(await clearEventSubRevoked("stream.online")).toBe(true)
    expect(await clearEventSubRevoked("stream.online")).toBe(false)
    expect(await clearEventSubRevoked("stream.offline")).toBe(true)
    expect(settings()).toEqual({ user: grant() })
  })

  it("cost a notification one read when nothing is revoked (no lock, no write)", async () => {
    save({ user: grant() })
    expect(await clearEventSubRevoked("stream.online")).toBe(false)
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})
