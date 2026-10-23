import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes } from "../fakes/testing"
import { twitchApi } from "./client"
import { applySubscriptionPlan, callbackProblem, listSubscriptions, planSubscriptions, PRODUCTION_CALLBACK, type Subscription } from "./eventsub-setup"
import { TWITCH_FAKE, twitchFake } from "./fake/handlers"

vi.mock("@/server/db", () => ({ prisma: {} }))

afterEach(() => {
  vi.unstubAllGlobals()
})

const CLUB = TWITCH_FAKE.broadcasterId
const sub = (type: string, status: string, callback = PRODUCTION_CALLBACK, broadcaster = CLUB): Subscription => ({ id: `${type}-${status}-${callback}`, type, status, callback, condition: { broadcaster_user_id: broadcaster } })

describe("planning the subscriptions", () => {
  it("creates both when there are none", () => {
    expect(planSubscriptions([], PRODUCTION_CALLBACK, CLUB)).toEqual({ keep: [], remove: [], create: ["stream.online", "stream.offline"], elsewhere: [] })
  })

  it("keeps live ones, replaces failed or revoked ones, and leaves other callbacks and channels alone", () => {
    const online = sub("stream.online", "enabled")
    const failed = sub("stream.offline", "webhook_callback_verification_failed")
    const tunnel = sub("stream.online", "enabled", "https://abc.ngrok.app/api/webhooks/twitch")
    const otherChannel = sub("stream.offline", "enabled", PRODUCTION_CALLBACK, "999")
    expect(planSubscriptions([online, failed, tunnel, otherChannel], PRODUCTION_CALLBACK, CLUB)).toEqual({ keep: [online], remove: [failed], create: ["stream.offline"], elsewhere: [tunnel] })
  })

  it("counts a subscription waiting for its challenge as live, and drops a duplicate", () => {
    const pending = sub("stream.online", "webhook_callback_verification_pending")
    const revoked = { ...sub("stream.online", "authorization_revoked"), id: "old" }
    const offline = sub("stream.offline", "enabled")
    expect(planSubscriptions([revoked, pending, offline], PRODUCTION_CALLBACK, CLUB)).toMatchObject({ keep: [pending, offline], remove: [revoked], create: [] })
  })
})

describe("the callback", () => {
  it("is production's exact URL unless --local", () => {
    expect(callbackProblem(PRODUCTION_CALLBACK, { local: false })).toBeNull()
    expect(callbackProblem("https://longhornsimracing.org/api/webhooks/twitch", { local: false })).toContain("Pass --local")
    expect(callbackProblem(`${PRODUCTION_CALLBACK}/`, { local: false })).toContain("Only https://www.longhornsimracing.org/api/webhooks/twitch")
    expect(callbackProblem("http://localhost:3133/api/webhooks/twitch", { local: false })).toContain("Pass --local")
    expect(callbackProblem("http://localhost:3133/api/webhooks/twitch", { local: true })).toBeNull()
    expect(callbackProblem("ftp://x", { local: true })).toBe("The callback must be http(s).")
    expect(callbackProblem("nope", { local: true })).toBe('"nope" isn\'t a URL.')
  })
})

describe("applying a plan against the fake", () => {
  it("creates the subscriptions with our secret and the app token, then lists them, and is idempotent", async () => {
    const fakes = mountFakes([twitchFake])
    const api = twitchApi({ clientId: TWITCH_FAKE.clientId, clientSecret: TWITCH_FAKE.clientSecret })
    const { access_token: token } = await api.mintAppToken()
    const options = { callback: PRODUCTION_CALLBACK, secret: TWITCH_FAKE.eventSubSecret, broadcasterId: CLUB }

    const first = planSubscriptions((await listSubscriptions(api, token, CLUB)).subscriptions, PRODUCTION_CALLBACK, CLUB)
    expect(await applySubscriptionPlan(api, token, first, options)).toEqual({ removed: 0, created: ["stream.online", "stream.offline"] })
    const created = fakes.requests.filter((r) => r.method === "POST" && r.path === "/helix/eventsub/subscriptions").map((r) => JSON.parse(r.body))
    expect(created[0]).toEqual({ type: "stream.online", version: "1", condition: { broadcaster_user_id: CLUB }, transport: { method: "webhook", callback: PRODUCTION_CALLBACK, secret: TWITCH_FAKE.eventSubSecret } })

    // The challenge can't reach production from a test, so the fake marks them failed; the next plan replaces them
    await vi.waitFor(async () => expect((await listSubscriptions(api, token, CLUB)).subscriptions.map((s) => s.status)).toEqual(["webhook_callback_verification_failed", "webhook_callback_verification_failed"]))
    const again = planSubscriptions((await listSubscriptions(api, token, CLUB)).subscriptions, PRODUCTION_CALLBACK, CLUB)
    expect(again.remove).toHaveLength(2)
    expect(await applySubscriptionPlan(api, token, again, options)).toEqual({ removed: 2, created: ["stream.online", "stream.offline"] })
    expect((await listSubscriptions(api, token, CLUB)).subscriptions).toHaveLength(2)
  })

  it("treats a 409 (it exists already) as done", async () => {
    mountFakes([twitchFake])
    const api = twitchApi({ clientId: TWITCH_FAKE.clientId, clientSecret: TWITCH_FAKE.clientSecret })
    const { access_token: token } = await api.mintAppToken()
    const options = { callback: "http://localhost:3133/api/webhooks/twitch", secret: TWITCH_FAKE.eventSubSecret, broadcasterId: CLUB }
    await applySubscriptionPlan(api, token, { keep: [], remove: [], create: ["stream.online"], elsewhere: [] }, options)
    expect(await applySubscriptionPlan(api, token, { keep: [], remove: [], create: ["stream.online"], elsewhere: [] }, options)).toEqual({ removed: 0, created: [] })
  })
})
