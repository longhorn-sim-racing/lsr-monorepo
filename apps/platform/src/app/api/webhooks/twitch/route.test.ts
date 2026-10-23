import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FakeSourcesBDb } from "@/server/connectors/sources-b-test-db"

const db = vi.hoisted(() => ({ current: null as FakeSourcesBDb | null }))
const state = vi.hoisted(() => ({ enabled: true, errors: [] as string[], syncs: 0 }))
const after = vi.hoisted(() => ({ tasks: [] as (() => Promise<unknown>)[] }))
vi.mock("@/server/db", () => ({
  prisma: new Proxy({}, { get: (_target, table: string) => (db.current as Record<string, unknown> | null)?.[table] }),
}))
vi.mock("@/server/connectors/state", () => ({
  connectorEnabled: vi.fn(async () => state.enabled),
  readConnectorState: vi.fn(async () => null),
  recordConnectorSync: vi.fn(async () => {
    state.syncs++
  }),
  recordConnectorError: vi.fn(async (_id: string, error: unknown) => {
    state.errors.push(String(error))
    return ""
  }),
}))
vi.mock("@/server/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    after.tasks.push(task)
    return Promise.resolve()
  },
}))

import { mountFakes } from "@/server/connectors/fakes/testing"
import { fakeSourcesBDb } from "@/server/connectors/sources-b-test-db"
import { twitchApi } from "@/server/connectors/twitch/client"
import { twitchClient, twitchConnector } from "@/server/connectors/twitch/connector"
import { EVENTSUB_HEADERS, eventSubSignature } from "@/server/connectors/twitch/eventsub"
import { nanoTimestamp, TWITCH_FAKE, twitchFake } from "@/server/connectors/twitch/fake/handlers"
import { memoryTwitchTokens } from "@/server/connectors/twitch/tokens"
import * as route from "./route"

const SECRET = TWITCH_FAKE.eventSubSecret
const CLUB = TWITCH_FAKE.broadcasterId
const CALLBACK = "http://localhost:3133/api/webhooks/twitch"
let tables: FakeSourcesBDb
let seq = 0

const subscription = (type: string, broadcaster: string = CLUB) => ({ id: "sub-1", type, version: "1", status: "enabled", cost: 0, condition: { broadcaster_user_id: broadcaster }, transport: { method: "webhook", callback: CALLBACK }, created_at: "2026-10-22T00:00:00Z" })
const club = { broadcaster_user_id: CLUB, broadcaster_user_login: TWITCH_FAKE.broadcasterLogin, broadcaster_user_name: TWITCH_FAKE.broadcasterName }

/** A delivery as Twitch sends it, signed over the exact body */
function delivery(type: "notification" | "webhook_callback_verification" | "revocation", payload: Record<string, unknown>, { id = `msg-${++seq}`, at = Date.now(), secret = SECRET, retry = false, signature }: { id?: string; at?: number; secret?: string; retry?: boolean; signature?: string } = {}) {
  const body = JSON.stringify(payload)
  const timestamp = nanoTimestamp(at)
  return new Request(CALLBACK, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [EVENTSUB_HEADERS.id]: id,
      [EVENTSUB_HEADERS.retry]: retry ? "1" : "0",
      [EVENTSUB_HEADERS.type]: type,
      [EVENTSUB_HEADERS.timestamp]: timestamp,
      [EVENTSUB_HEADERS.signature]: signature ?? eventSubSignature(secret, id, timestamp, body),
      [EVENTSUB_HEADERS.subscriptionType]: String((payload.subscription as { type?: string })?.type ?? ""),
      [EVENTSUB_HEADERS.subscriptionVersion]: "1",
    },
    body,
  })
}
const online = (streamId: string, options: Parameters<typeof delivery>[2] & { streamType?: string; startedAt?: string } = {}) =>
  delivery("notification", { subscription: subscription("stream.online"), event: { id: streamId, ...club, type: options.streamType ?? "live", started_at: options.startedAt ?? "2026-10-22T23:00:00.123Z" } }, options)
const offline = (options: Parameters<typeof delivery>[2] = {}) => delivery("notification", { subscription: subscription("stream.offline"), event: { ...club } }, options)

beforeEach(() => {
  tables = fakeSourcesBDb()
  db.current = tables
  state.enabled = true
  state.errors = []
  state.syncs = 0
  after.tasks = []
  vi.stubEnv("TWITCH_EVENTSUB_SECRET", SECRET)
  vi.stubEnv("TWITCH_BROADCASTER_ID", CLUB)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("POST /api/webhooks/twitch", () => {
  it("answers a signed challenge with the raw string as text/plain", async () => {
    const res = await route.POST(delivery("webhook_callback_verification", { challenge: "pogchamp-kappa-360noscope-vohiyo", subscription: { ...subscription("stream.online"), status: "webhook_callback_verification_pending" } }))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/plain")
    expect(await res.text()).toBe("pogchamp-kappa-360noscope-vohiyo")
  })

  it("answers challenges while the connector is switched off (setup comes first), but only for the club's channel", async () => {
    state.enabled = false
    expect((await route.POST(delivery("webhook_callback_verification", { challenge: "c1", subscription: subscription("stream.online") }))).status).toBe(200)
    expect((await route.POST(delivery("webhook_callback_verification", { challenge: "c2", subscription: subscription("stream.online", "999") }))).status).toBe(403)
  })

  it("refuses unsigned, wrongly signed, stale and secretless deliveries with 403, and reads nothing", async () => {
    expect((await route.POST(online("1", { signature: `sha256=${"0".repeat(64)}` }))).status).toBe(403)
    expect((await route.POST(online("1", { secret: "someone-elses-secret" }))).status).toBe(403)
    expect((await route.POST(online("1", { at: Date.now() - 11 * 60_000 }))).status).toBe(403)
    vi.stubEnv("TWITCH_EVENTSUB_SECRET", "")
    expect((await route.POST(online("1"))).status).toBe(403)
    expect(tables.twitchStream.all()).toEqual([])
    expect(tables.twitchEventSubMessage.all()).toEqual([])
  })

  it("opens a stream on stream.online, then reads its title after the response", async () => {
    const fakes = mountFakes([twitchFake])
    await fetch(`${fakes.origin}/twitch/_fake/live`, { method: "POST", body: JSON.stringify({ title: "GM 3 watch party", gameName: "iRacing", notify: false }) })
    vi.spyOn(twitchConnector, "client").mockResolvedValue(twitchClient({ ...process.env, TWITCH_CLIENT_ID: TWITCH_FAKE.clientId, TWITCH_CLIENT_SECRET: TWITCH_FAKE.clientSecret, TWITCH_BROADCASTER_ID: CLUB }, memoryTwitchTokens()))

    const res = await route.POST(online("40952121001"))
    expect(res.status).toBe(204)
    expect(tables.twitchStream.rows.get("40952121001")).toMatchObject({ title: "", startedAt: new Date("2026-10-22T23:00:00.123Z"), endedAt: null })
    expect(state.syncs).toBe(1)

    expect(after.tasks).toHaveLength(1)
    await after.tasks[0]()
    expect(tables.twitchStream.rows.get("40952121001")).toMatchObject({ title: "GM 3 watch party", gameName: "iRacing" })
  })

  it("handles each message id once: a resend gets 204 and nothing else", async () => {
    await route.POST(online("777", { id: "msg-fixed" }))
    tables.twitchStream.rows.clear()
    const res = await route.POST(online("777", { id: "msg-fixed", retry: true }))
    expect(res.status).toBe(204)
    expect(tables.twitchStream.all()).toEqual([])
    expect(tables.twitchEventSubMessage.all().map((m) => m.id)).toEqual(["msg-fixed"])
  })

  it("ignores reruns, premieres and other channels", async () => {
    expect((await route.POST(online("888", { streamType: "rerun" }))).status).toBe(204)
    expect((await route.POST(delivery("notification", { subscription: subscription("stream.online", "999"), event: { id: "889", broadcaster_user_id: "999", broadcaster_user_login: "x", broadcaster_user_name: "X", type: "live", started_at: "2026-10-22T23:00:00Z" } }))).status).toBe(204)
    expect(tables.twitchStream.all()).toEqual([])
  })

  it("closes the open stream on stream.offline, at the message's time", async () => {
    await route.POST(online("555", { startedAt: new Date(Date.now() - 3_600_000).toISOString() }))
    const sentAt = Date.now() - 1_000
    expect((await route.POST(offline({ at: sentAt }))).status).toBe(204)
    expect(tables.twitchStream.rows.get("555")?.endedAt).toEqual(new Date(sentAt))
  })

  it("ignores notifications while the connector is switched off, without using up their ids", async () => {
    state.enabled = false
    expect((await route.POST(online("666", { id: "msg-off" }))).status).toBe(204)
    expect(tables.twitchStream.all()).toEqual([])
    state.enabled = true
    await route.POST(online("666", { id: "msg-off", retry: true }))
    expect(tables.twitchStream.rows.has("666")).toBe(true)
  })

  it("records a revocation on the connector, once", async () => {
    const revoked = { subscription: { ...subscription("stream.online"), status: "authorization_revoked" } }
    expect((await route.POST(delivery("revocation", revoked, { id: "rev-1" }))).status).toBe(204)
    await route.POST(delivery("revocation", revoked, { id: "rev-1", retry: true }))
    expect(state.errors).toEqual(["Twitch revoked the stream.online webhook subscription (authorization_revoked). Run scripts/twitch-eventsub.ts --apply again (docs/jack-2/tracks/sources-b.md)."])
  })

  it("answers 500 when handling fails, and lets Twitch's resend through", async () => {
    const createMany = tables.twitchStream.createMany.bind(tables.twitchStream)
    const spy = vi.spyOn(tables.twitchStream, "createMany").mockRejectedValueOnce(new Error("database went away"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect((await route.POST(online("999", { id: "msg-fail" }))).status).toBe(500)
    expect(tables.twitchEventSubMessage.all()).toEqual([])
    spy.mockImplementation(createMany)
    expect((await route.POST(online("999", { id: "msg-fail", retry: true }))).status).toBe(204)
    expect(tables.twitchStream.rows.has("999")).toBe(true)
  })

  it("refuses bodies that aren't JSON, and oversized ones", async () => {
    const bad = delivery("notification", {})
    const text = "not json"
    const ts = nanoTimestamp(Date.now())
    const signed = new Request(CALLBACK, { method: "POST", headers: { ...Object.fromEntries(bad.headers), [EVENTSUB_HEADERS.timestamp]: ts, [EVENTSUB_HEADERS.signature]: eventSubSignature(SECRET, bad.headers.get(EVENTSUB_HEADERS.id)!, ts, text) }, body: text })
    expect((await route.POST(signed)).status).toBe(400)
    expect((await route.POST(new Request(CALLBACK, { method: "POST", body: "x".repeat(70_000) }))).status).toBe(413)
  })
})

describe("the fake's EventSub sender against this route", () => {
  it("subscribes (challenge answered, enabled), then delivers go-live and offline that the route accepts", async () => {
    const fakes = mountFakes([twitchFake])
    // Deliveries to the callback go to this route; everything else to the fakes
    const fakeFetch = globalThis.fetch
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      return request.url === CALLBACK ? route.POST(request) : fakeFetch(request)
    })
    const env = { ...process.env, TWITCH_CLIENT_ID: TWITCH_FAKE.clientId, TWITCH_CLIENT_SECRET: TWITCH_FAKE.clientSecret, TWITCH_BROADCASTER_ID: CLUB }
    const api = twitchApi({ clientId: TWITCH_FAKE.clientId, clientSecret: TWITCH_FAKE.clientSecret }, env)
    const { access_token: token } = await api.mintAppToken()
    await api.helix("/eventsub/subscriptions", { token, method: "POST", body: { type: "stream.online", version: "1", condition: { broadcaster_user_id: CLUB }, transport: { method: "webhook", callback: CALLBACK, secret: SECRET } } })
    await api.helix("/eventsub/subscriptions", { token, method: "POST", body: { type: "stream.offline", version: "1", condition: { broadcaster_user_id: CLUB }, transport: { method: "webhook", callback: CALLBACK, secret: SECRET } } })
    await vi.waitFor(async () => {
      const list = await api.helix<{ data: { status: string }[] }>("/eventsub/subscriptions", { token })
      expect(list.data.map((s) => s.status)).toEqual(["enabled", "enabled"])
    })

    const live = await (await fetch(`${fakes.origin}/twitch/_fake/live`, { method: "POST", body: JSON.stringify({ title: "Practice" }) })).json()
    expect(live.deliveries).toEqual([expect.objectContaining({ status: 204 })])
    expect(tables.twitchStream.rows.get(live.stream.id)).toMatchObject({ endedAt: null })

    // A resend of the same message, and one with a bad signature
    const resend = await (await fetch(`${fakes.origin}/twitch/_fake/eventsub/send`, { method: "POST", body: JSON.stringify({ type: "stream.online", duplicate: true }) })).json()
    expect(resend.deliveries.map((d: { status: number }) => d.status)).toEqual([204, 204])
    const forged = await (await fetch(`${fakes.origin}/twitch/_fake/eventsub/send`, { method: "POST", body: JSON.stringify({ type: "stream.offline", badSignature: true }) })).json()
    expect(forged.deliveries[0].status).toBe(403)
    expect(tables.twitchStream.rows.get(live.stream.id)?.endedAt).toBeNull()

    const ended = await (await fetch(`${fakes.origin}/twitch/_fake/offline`, { method: "POST", body: "{}" })).json()
    expect(ended.deliveries).toEqual([expect.objectContaining({ status: 204 })])
    expect(tables.twitchStream.rows.get(live.stream.id)?.endedAt).toBeInstanceOf(Date)
  })
})
