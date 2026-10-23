import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes } from "../fakes/testing"
import { GRAPH_FAKE } from "../microsoft/fake/fixtures"
import { microsoftGraphFake } from "../microsoft/fake/handlers"
import { graphClient } from "../microsoft/graph"
import type { TeamsConnection } from "./connector"
import { subscriptionResource } from "./messages"
import { clientStateMatches, parseNotifications, processLifecycleEvents, processMessageNotifications, type GraphNotification } from "./notifications"
import { clientStateHash } from "./subscriptions"
import { memorySubscriptionStore, memoryTeamsStore } from "./testing"

afterEach(() => {
  vi.unstubAllGlobals()
})

const { general, sponsorship } = GRAPH_FAKE.channels
const team = GRAPH_FAKE.teamId

async function setup() {
  const fakes = mountFakes([microsoftGraphFake])
  await fetch(`${fakes.origin}/microsoft-graph/_fake/config`, { method: "POST", body: JSON.stringify({ validateEndpoints: false }) })
  const graph = graphClient({ tenantId: GRAPH_FAKE.tenantId, clientId: GRAPH_FAKE.clientId, clientSecret: GRAPH_FAKE.clientSecret }, { retryDelayMs: 0 })
  const connection: TeamsConnection = { graph, teamId: team, channelIds: [general, sponsorship], clientState: GRAPH_FAKE.clientState }
  const teams = memoryTeamsStore()
  const subscriptions = memorySubscriptionStore()
  // Our subscription on #general, as the subscriptions job would have saved it
  const created = await graph.post<{ id: string; expirationDateTime: string }>("/subscriptions", {
    changeType: "created,updated,deleted",
    notificationUrl: "https://x.example/api/webhooks/graph",
    lifecycleNotificationUrl: "https://x.example/api/webhooks/graph/lifecycle",
    resource: subscriptionResource(team, general),
    expirationDateTime: new Date(Date.now() + 60 * 60_000).toISOString(),
    clientState: GRAPH_FAKE.clientState,
  })
  await subscriptions.save({ id: created.id, resource: subscriptionResource(team, general), expiresAt: new Date(created.expirationDateTime), clientStateHash: clientStateHash(GRAPH_FAKE.clientState) })
  const deps = { connection, teams, subscriptions }
  const notification = (fields: Partial<GraphNotification> & { message: string; reply?: string; channel?: string }): GraphNotification => ({
    subscriptionId: created.id,
    changeType: "created",
    clientState: GRAPH_FAKE.clientState,
    resource: `teams('${team}')/channels('${fields.channel ?? general}')/messages('${fields.message}')${fields.reply ? `/replies('${fields.reply}')` : ""}`,
    ...fields,
  })
  return { fakes, graph, teams, subscriptions, deps, subscriptionId: created.id, notification }
}

describe("clientStateMatches", () => {
  it("compares in constant time, and refuses anything that isn't the secret", () => {
    expect(clientStateMatches("secret-value", "secret-value")).toBe(true)
    expect(clientStateMatches("secret-valuf", "secret-value")).toBe(false)
    expect(clientStateMatches("secret", "secret-value")).toBe(false)
    expect(clientStateMatches(undefined, "secret-value")).toBe(false)
    expect(clientStateMatches("", "")).toBe(false)
  })
})

describe("parseNotifications", () => {
  it("takes Graph's value array and nothing else", () => {
    expect(parseNotifications('{"value":[{"subscriptionId":"s"}]}')).toEqual([{ subscriptionId: "s" }])
    expect(parseNotifications('{"value":"no"}')).toBeNull()
    expect(parseNotifications("not json")).toBeNull()
  })
})

describe("processMessageNotifications", () => {
  it("fetches and saves a new message or reply it points at", async () => {
    const { teams, deps, notification } = await setup()
    const result = await processMessageNotifications([notification({ message: "1760454000000" }), notification({ message: "1760454000000", reply: "1760454600000" })], deps)
    expect(result).toEqual({ saved: 2, purged: 0, dropped: 0 })
    expect(teams.messages.get("1760454600000")).toMatchObject({ replyToId: "1760454000000", content: "I do. @Fixture Officer A, grab it from me before Friday." })
    // The channel is there for search before the daily sync has named it
    expect(teams.channels.get(general)).toMatchObject({ synced: true })
  })

  it("purges a deleted message, and one Graph no longer has", async () => {
    const { teams, deps, notification } = await setup()
    await processMessageNotifications([notification({ message: "1760454000000" })], deps)
    expect(await processMessageNotifications([notification({ message: "1760454000000", changeType: "deleted" })], deps)).toMatchObject({ purged: 1 })
    expect(teams.messages.get("1760454000000")).toMatchObject({ content: "", deletedAt: expect.any(Date) })
    await teams.saveMessage({ id: "999", channelId: general, replyToId: null, authorAadId: null, authorName: "X", content: "gone soon", createdAt: new Date(), editedAt: null, deletedAt: null })
    expect(await processMessageNotifications([notification({ message: "999", changeType: "updated" })], deps)).toMatchObject({ purged: 1 })
  })

  it("drops what isn't ours: another subscription, another team, a channel not configured, an older secret", async () => {
    const { teams, subscriptions, deps, notification, subscriptionId } = await setup()
    const dropped = await processMessageNotifications(
      [
        notification({ message: "1760454000000", subscriptionId: "someone-elses" }),
        notification({ message: "1760454000000", resource: `teams('another-team')/channels('${general}')/messages('1760454000000')` }),
        notification({ message: "1760454000000", channel: "19:not-configured@thread.tacv2" }),
        notification({ message: "1760454000000", resource: "users('u')/messages('1')" }),
      ],
      deps,
    )
    expect(dropped).toEqual({ saved: 0, purged: 0, dropped: 4 })
    const row = (await subscriptions.find(subscriptionId))!
    await subscriptions.save({ ...row, clientStateHash: clientStateHash("an-older-secret") })
    expect(await processMessageNotifications([notification({ message: "1760454000000" })], deps)).toMatchObject({ dropped: 1 })
    expect(teams.messages.size).toBe(0)
  })

  it("handles a repeated notification once", async () => {
    const { fakes, deps, notification } = await setup()
    await processMessageNotifications([notification({ message: "1760454000000" }), notification({ message: "1760454000000" })], deps)
    expect(fakes.requests.filter((r) => r.path.endsWith("/messages/1760454000000"))).toHaveLength(1)
  })
})

describe("processLifecycleEvents", () => {
  it("renews on reauthorizationRequired", async () => {
    const { subscriptions, deps, subscriptionId } = await setup()
    const before = (await subscriptions.find(subscriptionId))!.expiresAt
    const result = await processLifecycleEvents([{ subscriptionId, clientState: GRAPH_FAKE.clientState, lifecycleEvent: "reauthorizationRequired" }], { ...deps, deadline: Date.now() + 30_000 })
    expect(result).toMatchObject({ renewed: 1 })
    expect((await subscriptions.find(subscriptionId))!.expiresAt.getTime()).toBeGreaterThan(before.getTime())
  })

  it("makes a new subscription on subscriptionRemoved and catches the channel up", async () => {
    const { teams, subscriptions, deps, subscriptionId } = await setup()
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.longhornsimracing.org")
    const result = await processLifecycleEvents([{ subscriptionId, clientState: GRAPH_FAKE.clientState, lifecycleEvent: "subscriptionRemoved" }], { ...deps, deadline: Date.now() + 30_000 })
    expect(result).toMatchObject({ recreated: 1, reconciled: 1 })
    expect(await subscriptions.find(subscriptionId)).toBeNull()
    expect((await subscriptions.list())[0].resource).toBe(subscriptionResource(team, general))
    expect(teams.messages.get("1760454600000")).toBeTruthy()
    // Only that channel: the others are left alone
    expect([...teams.messages.values()].some((m) => m.channelId === sponsorship)).toBe(false)
  })

  it("drops events for subscriptions that aren't ours", async () => {
    const { deps } = await setup()
    expect(await processLifecycleEvents([{ subscriptionId: "nope", lifecycleEvent: "missed" }], { ...deps, deadline: Date.now() + 30_000 })).toMatchObject({ dropped: 1 })
  })
})
