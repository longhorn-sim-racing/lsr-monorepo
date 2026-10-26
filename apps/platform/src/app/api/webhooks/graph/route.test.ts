import { beforeEach, describe, expect, it, vi } from "vitest"

const after = vi.hoisted(() => ({ tasks: [] as (() => Promise<unknown>)[] }))
const processing = vi.hoisted(() => ({ processMessageNotifications: vi.fn(), processLifecycleEvents: vi.fn() }))
const connector = vi.hoisted(() => ({ client: vi.fn() }))

vi.mock("@/server/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    after.tasks.push(task)
    return Promise.resolve()
  },
}))
vi.mock("@/server/connectors/teams/notifications", async (importOriginal) => ({ ...(await importOriginal<object>()), ...processing }))
vi.mock("@/server/connectors/teams/connector", () => ({ teamsConnector: connector }))
vi.mock("@/server/connectors/teams/store", () => ({ prismaTeamsStore: () => ({}), prismaSubscriptionStore: () => ({}) }))

import * as lifecycle from "./lifecycle/route"
import * as route from "./route"

const SECRET = "client-state-" + "x".repeat(32)

const post = (body: string, query = "", path = "/api/webhooks/graph") => new Request(`https://www.longhornsimracing.org${path}${query}`, { method: "POST", headers: { "content-type": "application/json" }, body })
const notification = (clientState: string) => ({ subscriptionId: "sub-1", changeType: "created", clientState, resource: "teams('t')/channels('19:c@thread.tacv2')/messages('1')" })

beforeEach(() => {
  after.tasks = []
  vi.stubEnv("MS_GRAPH_CLIENT_STATE", SECRET)
  connector.client.mockResolvedValue({ teamId: "t", channelIds: ["19:c@thread.tacv2"], clientState: SECRET, graph: {} })
  processing.processMessageNotifications.mockResolvedValue({ saved: 1, purged: 0, dropped: 0 })
  processing.processLifecycleEvents.mockResolvedValue({ renewed: 1, recreated: 0, reconciled: 0, dropped: 0 })
})

describe("POST /api/webhooks/graph", () => {
  it("echoes Graph's validation token as plain text", async () => {
    const token = "Validation: Token-With+Symbols/="
    const res = await route.POST(post("", `?validationToken=${encodeURIComponent(token)}`))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await res.text()).toBe(token)
  })

  it("refuses everything, validation included, when MS_GRAPH_CLIENT_STATE isn't set", async () => {
    vi.stubEnv("MS_GRAPH_CLIENT_STATE", "")
    expect((await route.POST(post("", "?validationToken=abc"))).status).toBe(503)
    expect((await route.POST(post(JSON.stringify({ value: [notification(SECRET)] })))).status).toBe(503)
    expect(after.tasks).toHaveLength(0)
  })

  it("answers 202 at once and processes the notifications after the response", async () => {
    const res = await route.POST(post(JSON.stringify({ value: [notification(SECRET)] })))
    expect(res.status).toBe(202)
    expect(processing.processMessageNotifications).not.toHaveBeenCalled()
    expect(after.tasks).toHaveLength(1)
    await after.tasks[0]()
    expect(processing.processMessageNotifications).toHaveBeenCalledWith([notification(SECRET)], expect.objectContaining({ connection: expect.objectContaining({ teamId: "t" }) }))
  })

  it("drops notifications with the wrong clientState (still 202, nothing processed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await route.POST(post(JSON.stringify({ value: [notification("forged-state-1234"), notification(SECRET.slice(0, -1))] })))
    expect(res.status).toBe(202)
    expect(after.tasks).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Dropped 2"))
    expect(String(warn.mock.calls[0][0])).not.toContain("forged-state-1234")
  })

  it("keeps the valid ones of a mixed batch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await route.POST(post(JSON.stringify({ value: [notification("wrong"), notification(SECRET)] })))
    await after.tasks[0]()
    expect(processing.processMessageNotifications.mock.calls[0][0]).toHaveLength(1)
  })

  it("drops valid notifications while Teams is switched off", async () => {
    connector.client.mockResolvedValue(null)
    await route.POST(post(JSON.stringify({ value: [notification(SECRET)] })))
    await after.tasks[0]()
    expect(processing.processMessageNotifications).not.toHaveBeenCalled()
  })

  it("refuses a body that isn't a notification batch, or is far too big", async () => {
    expect((await route.POST(post("not json"))).status).toBe(400)
    expect((await route.POST(post(JSON.stringify({ value: "x" })))).status).toBe(400)
    expect((await route.POST(post("x".repeat(1_000_001)))).status).toBe(413)
    expect((await route.POST(post("", `?validationToken=${"a".repeat(2_000)}`))).status).toBe(400)
  })
})

describe("POST /api/webhooks/graph/lifecycle", () => {
  it("validates the same way and hands lifecycle events to their own processing", async () => {
    const validation = await lifecycle.POST(post("", "?validationToken=abc", "/api/webhooks/graph/lifecycle"))
    expect(await validation.text()).toBe("abc")
    const event = { subscriptionId: "sub-1", clientState: SECRET, lifecycleEvent: "reauthorizationRequired" }
    expect((await lifecycle.POST(post(JSON.stringify({ value: [event] }), "", "/api/webhooks/graph/lifecycle"))).status).toBe(202)
    await after.tasks[0]()
    expect(processing.processLifecycleEvents).toHaveBeenCalledWith([event], expect.objectContaining({ deadline: expect.any(Number) }))
    expect(processing.processMessageNotifications).not.toHaveBeenCalled()
  })
})
