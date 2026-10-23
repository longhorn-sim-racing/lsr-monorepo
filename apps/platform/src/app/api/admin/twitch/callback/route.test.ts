import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireRole: vi.fn() }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const tokens = vi.hoisted(() => ({ saveTwitchClubGrant: vi.fn() }))
const state = vi.hoisted(() => ({ recordConnectorError: vi.fn(), CONNECTOR_ENTITY: "CONNECTOR" }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/connectors/twitch/tokens", () => tokens)
vi.mock("@/server/connectors/state", () => state)
vi.mock("@/server/db", () => ({ prisma: {} }))

import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { TWITCH_FAKE, twitchFake } from "@/server/connectors/twitch/fake/handlers"
import { checkTwitchOAuthState, createTwitchOAuthState, TWITCH_OAUTH_COOKIE } from "@/server/connectors/twitch/oauth"
import * as connect from "../connect/route"
import * as callback from "./route"

const SITE = "https://www.longhornsimracing.org"
let fakes: MountedFakes

beforeEach(() => {
  fakes = mountFakes([twitchFake])
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE)
  vi.stubEnv("TWITCH_CLIENT_ID", TWITCH_FAKE.clientId)
  vi.stubEnv("TWITCH_CLIENT_SECRET", TWITCH_FAKE.clientSecret)
  vi.stubEnv("TWITCH_BROADCASTER_ID", TWITCH_FAKE.broadcasterId)
  guards.requireRole.mockResolvedValue({ id: "admin-1" })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const hook = (path: string, body: unknown) => fetch(`${fakes.origin}/twitch/_fake/${path}`, { method: "POST", body: JSON.stringify(body) })

/** Starts the connect flow, follows the fake consent page, and returns the callback request the browser would make */
async function throughConsent(): Promise<NextRequest> {
  const start = await connect.GET(new NextRequest(`${SITE}/api/admin/twitch/connect`))
  const cookie = start.cookies.get(TWITCH_OAUTH_COOKIE)?.value ?? ""
  const consent = await fetch(start.headers.get("location") ?? "", { redirect: "manual" })
  return new NextRequest(consent.headers.get("location") ?? "", { headers: { cookie: `${TWITCH_OAUTH_COOKIE}=${cookie}` } })
}

const resultOf = (res: Response) => new URL(res.headers.get("location") ?? "").searchParams.get("twitch")

describe("the OAuth state", () => {
  const SECRET = "client-secret-for-the-test"
  it("checks out for the same admin within ten minutes", () => {
    const { state, cookie } = createTwitchOAuthState(SECRET, "admin-1", 1_000)
    expect(checkTwitchOAuthState({ cookie, state, userId: "admin-1", secret: SECRET, nowMs: 1_000 + 9 * 60_000 })).toEqual({ ok: true })
  })

  it("refuses another admin, another state, a forged or expired cookie, and nothing at all", () => {
    const { state, cookie } = createTwitchOAuthState(SECRET, "admin-1", 1_000)
    const check = (overrides: Partial<Parameters<typeof checkTwitchOAuthState>[0]>) => checkTwitchOAuthState({ cookie, state, userId: "admin-1", secret: SECRET, nowMs: 2_000, ...overrides })
    expect(check({ userId: "admin-2" })).toEqual({ ok: false, reason: "mismatch" })
    expect(check({ state: "another-state" })).toEqual({ ok: false, reason: "mismatch" })
    expect(check({ secret: "another-secret" })).toEqual({ ok: false, reason: "mismatch" })
    const [s, , mac] = cookie.split(".")
    expect(check({ cookie: `${s}.${Date.now() + 3_600_000}.${mac}` })).toEqual({ ok: false, reason: "mismatch" })
    expect(check({ nowMs: 1_000 + 10 * 60_000 })).toEqual({ ok: false, reason: "expired" })
    expect(check({ cookie: "garbage" })).toEqual({ ok: false, reason: "malformed" })
    expect(check({ cookie: undefined })).toEqual({ ok: false, reason: "missing" })
    expect(check({ state: null })).toEqual({ ok: false, reason: "missing" })
  })
})

describe("GET /api/admin/twitch/connect", () => {
  it("sends an admin to Twitch's consent page, with the state in a short httpOnly cookie for these routes", async () => {
    const res = await connect.GET(new NextRequest(`${SITE}/api/admin/twitch/connect`))
    const target = new URL(res.headers.get("location") ?? "")
    expect(target.pathname).toBe("/twitch/oauth2/authorize")
    expect(target.searchParams.get("redirect_uri")).toBe(`${SITE}/api/admin/twitch/callback`)
    const cookie = res.headers.get("set-cookie") ?? ""
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=lax/i)
    expect(cookie).toMatch(/Path=\/api\/admin\/twitch/)
    expect(cookie).toMatch(/Max-Age=600/)
    expect(cookie.split(";")[0]).toContain(target.searchParams.get("state"))
  })

  it("keeps officers out, says when Twitch isn't set up, and moves to the registered host first", async () => {
    guards.requireRole.mockRejectedValueOnce(new Error("Requires one of the following roles: admin"))
    expect((await connect.GET(new NextRequest(`${SITE}/api/admin/twitch/connect`))).headers.get("location")).toBe(`${SITE}/403`)

    vi.stubEnv("TWITCH_CLIENT_SECRET", "")
    expect(resultOf(await connect.GET(new NextRequest(`${SITE}/api/admin/twitch/connect`)))).toBe("not-configured")
    vi.stubEnv("TWITCH_CLIENT_SECRET", TWITCH_FAKE.clientSecret)

    const apex = await connect.GET(new NextRequest("https://longhornsimracing.org/api/admin/twitch/connect"))
    expect(apex.headers.get("location")).toBe(`${SITE}/api/admin/twitch/connect`)
    expect(apex.cookies.get(TWITCH_OAUTH_COOKIE)).toBeUndefined()
  })
})

describe("GET /api/admin/twitch/callback", () => {
  it("keeps the club account's grant, audits who connected it (no tokens), and clears the cookie", async () => {
    const res = await callback.GET(await throughConsent())
    expect(resultOf(res)).toBe("connected")
    expect(res.headers.get("set-cookie")).toMatch(/lsr_twitch_oauth=;.*Max-Age=0/i)
    expect(tokens.saveTwitchClubGrant).toHaveBeenCalledWith(
      expect.objectContaining({ login: TWITCH_FAKE.broadcasterLogin, userId: TWITCH_FAKE.broadcasterId, scopes: ["moderator:read:followers"], connectedById: "admin-1", accessToken: expect.stringMatching(/^fakeuser/), refreshToken: expect.stringMatching(/^fakerefresh/) }),
    )
    const entry = audit.createAuditLog.mock.calls[0][0]
    expect(entry).toMatchObject({ actorUserId: "admin-1", actionType: "CONNECT", entityType: "CONNECTOR", entityId: "twitch", summary: `Connected the club's Twitch account @${TWITCH_FAKE.broadcasterLogin}` })
    expect(JSON.stringify(entry)).not.toMatch(/fakeuser|fakerefresh/)
  })

  it("refuses someone's personal account and revokes its token at once", async () => {
    await hook("authorize", { as: "other" })
    const res = await callback.GET(await throughConsent())
    expect(resultOf(res)).toBe("wrong-account")
    expect(tokens.saveTwitchClubGrant).not.toHaveBeenCalled()
    expect(fakes.requests.some((r) => r.path === "/oauth2/revoke")).toBe(true)
    const state = await (await fetch(`${fakes.origin}/twitch/_fake/state`)).json()
    expect(state.tokens.user).toBe(0)
  })

  it("says so when Twitch access was denied", async () => {
    await hook("authorize", { deny: true })
    expect(resultOf(await callback.GET(await throughConsent()))).toBe("denied")
    expect(tokens.saveTwitchClubGrant).not.toHaveBeenCalled()
  })

  it("takes a code only with this admin's own unexpired cookie", async () => {
    const request = await throughConsent()
    // Another admin's session can't finish someone else's flow
    guards.requireRole.mockResolvedValueOnce({ id: "admin-2" })
    expect(resultOf(await callback.GET(request))).toBe("expired")
    // No cookie (another browser)
    expect(resultOf(await callback.GET(new NextRequest(request.url)))).toBe("expired")
    expect(tokens.saveTwitchClubGrant).not.toHaveBeenCalled()
  })

  it("records Twitch's error on the connector when the code swap fails", async () => {
    const request = await throughConsent()
    const url = new URL(request.url)
    url.searchParams.set("code", "not-a-code")
    const res = await callback.GET(new NextRequest(url, { headers: request.headers }))
    expect(resultOf(res)).toBe("failed")
    expect(state.recordConnectorError).toHaveBeenCalledWith("twitch", expect.objectContaining({ status: 400 }))
  })
})
