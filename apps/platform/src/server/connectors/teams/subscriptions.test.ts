import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes } from "../fakes/testing"
import { GRAPH_FAKE } from "../microsoft/fake/fixtures"
import { microsoftGraphFake } from "../microsoft/fake/handlers"
import { graphClient } from "../microsoft/graph"
import { subscriptionResource } from "./messages"
import { CHANGE_TYPES, clientStateHash, ensureSubscriptions, RENEW_WITHIN_MS, SUBSCRIPTION_MINUTES, webhookUrls, type EnsureSubscriptionsOptions } from "./subscriptions"
import { memorySubscriptionStore } from "./testing"

afterEach(() => {
  vi.unstubAllGlobals()
})

const { general, sponsorship } = GRAPH_FAKE.channels
const urls = { notificationUrl: "https://www.longhornsimracing.org/api/webhooks/graph", lifecycleUrl: "https://www.longhornsimracing.org/api/webhooks/graph/lifecycle" }

async function setup() {
  const fakes = mountFakes([microsoftGraphFake])
  // Graph would call our endpoints to validate them; the route tests cover that answer
  await fetch(`${fakes.origin}/microsoft-graph/_fake/config`, { method: "POST", body: JSON.stringify({ validateEndpoints: false }) })
  const store = memorySubscriptionStore()
  const graph = graphClient({ tenantId: GRAPH_FAKE.tenantId, clientId: GRAPH_FAKE.clientId, clientSecret: GRAPH_FAKE.clientSecret }, { retryDelayMs: 0 })
  const ensure = (extra: Partial<EnsureSubscriptionsOptions> = {}) => ensureSubscriptions({ graph, teamId: GRAPH_FAKE.teamId, channelIds: [general, sponsorship], clientState: GRAPH_FAKE.clientState, store, ...urls, ...extra })
  const graphSubscriptions = async () => (await graph.page<{ id: string; resource: string; expirationDateTime: string }>("/subscriptions")).value
  return { fakes, store, graph, ensure, graphSubscriptions }
}

describe("ensureSubscriptions", () => {
  it("subscribes to each channel's messages, created, updated and deleted, with the lifecycle endpoint", async () => {
    const { fakes, store, ensure, graphSubscriptions } = await setup()
    const now = new Date()
    expect(await ensure({ now })).toMatchObject({ created: 2 })
    const sent = JSON.parse(fakes.requests.find((r) => r.method === "POST" && r.path === "/v1.0/subscriptions")!.body)
    expect(sent).toMatchObject({ changeType: CHANGE_TYPES, resource: subscriptionResource(GRAPH_FAKE.teamId, general), includeResourceData: false, clientState: GRAPH_FAKE.clientState, ...{ notificationUrl: urls.notificationUrl, lifecycleNotificationUrl: urls.lifecycleUrl } })
    expect(Date.parse(sent.expirationDateTime) - now.getTime()).toBe(SUBSCRIPTION_MINUTES * 60_000)
    expect((await graphSubscriptions()).map((s) => s.resource).sort()).toEqual([subscriptionResource(GRAPH_FAKE.teamId, general), subscriptionResource(GRAPH_FAKE.teamId, sponsorship)].sort())
    // Our rows keep the secret's hash, never the secret
    for (const row of store.rows.values()) expect(row.clientStateHash).toBe(clientStateHash(GRAPH_FAKE.clientState))
    expect(JSON.stringify([...store.rows.values()])).not.toContain(GRAPH_FAKE.clientState)
  })

  it("keeps fresh ones and renews those with less than 36 hours left", async () => {
    const { store, ensure } = await setup()
    await ensure()
    expect(await ensure()).toMatchObject({ kept: 2, created: 0, renewed: 0 })
    const [first] = store.rows.values()
    store.rows.set(first.id, { ...first, expiresAt: new Date(Date.now() + RENEW_WITHIN_MS - 60_000) })
    expect(await ensure()).toMatchObject({ kept: 1, renewed: 1 })
    expect(store.rows.get(first.id)!.expiresAt.getTime()).toBeGreaterThan(Date.now() + RENEW_WITHIN_MS)
  })

  it("makes a new one when Graph lost it, and replaces ones made with an older secret", async () => {
    const { store, ensure, graph, graphSubscriptions } = await setup()
    await ensure()
    const [lost, old] = store.rows.values()
    await graph.delete(`/subscriptions/${lost.id}`)
    store.rows.set(lost.id, { ...lost, expiresAt: new Date(Date.now() + 60_000) })
    store.rows.set(old.id, { ...old, clientStateHash: clientStateHash("an-older-secret") })
    expect(await ensure()).toMatchObject({ created: 2, replaced: 1 })
    expect(await graphSubscriptions()).toHaveLength(2)
    expect([...store.rows.values()].every((row) => row.clientStateHash === clientStateHash(GRAPH_FAKE.clientState))).toBe(true)
  })

  it("removes the subscription of a channel no longer configured", async () => {
    const { store, ensure, graphSubscriptions } = await setup()
    await ensure()
    expect(await ensure({ channelIds: [general] })).toMatchObject({ deleted: 1, kept: 1 })
    expect((await graphSubscriptions()).map((s) => s.resource)).toEqual([subscriptionResource(GRAPH_FAKE.teamId, general)])
    expect(store.rows.size).toBe(1)
  })

  it("takes over when Graph already has one for the channel (409)", async () => {
    const { ensure, graphSubscriptions } = await setup()
    await ensure()
    // A fresh database, Graph still holding the old ones
    const counts = await ensure({ store: memorySubscriptionStore() })
    expect(counts.created).toBe(2)
    expect(await graphSubscriptions()).toHaveLength(2)
  })
})

describe("webhookUrls", () => {
  it("uses the site's https address, and refuses plain http unless the fakes are on", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.longhornsimracing.org")
    expect(webhookUrls()).toEqual(urls)
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3134")
    vi.stubEnv("JACK_FAKES", "")
    expect(() => webhookUrls()).toThrow("https")
    vi.stubEnv("JACK_FAKES", "microsoft-graph")
    expect(webhookUrls().notificationUrl).toBe("http://localhost:3134/api/webhooks/graph")
  })
})
