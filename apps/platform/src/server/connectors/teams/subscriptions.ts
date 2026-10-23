import { createHash } from "node:crypto"
import { getSiteUrl } from "@/lib/site-url"
import { fakesEnabledFor } from "../base-url"
import { GraphApiError, type GraphClient } from "../microsoft/graph"
import type { ConnectorEnv } from "../types"
import { subscriptionResource } from "./messages"
import type { GraphSubscriptionRow, SubscriptionStore } from "./store"

/**
 * Change-notification subscriptions for the configured channels (design §12.8; research §3f, §4). A
 * chat-message subscription lasts at most 3 days, so the `teams.subscriptions` job renews each one
 * when it has less than 36 hours left (it runs every 12 hours, so each is renewed about every 48
 * hours), creates missing ones, replaces ones made with an older MS_GRAPH_CLIENT_STATE, and deletes
 * ones for channels no longer configured. The secret itself is never stored: GraphSubscription keeps
 * its SHA-256, so a rotated secret is noticed.
 */

/** Just under Graph's 4,320-minute limit for chat messages */
export const SUBSCRIPTION_MINUTES = 4_230
export const RENEW_WITHIN_MS = 36 * 3_600_000
export const CHANGE_TYPES = "created,updated,deleted"

export const clientStateHash = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex")

/** Where Graph calls us: the site's own address, https (http only for the local fakes) */
export function webhookUrls(env: ConnectorEnv = process.env): { notificationUrl: string; lifecycleUrl: string } {
  const site = getSiteUrl()
  if (!site.startsWith("https://") && !fakesEnabledFor("microsoft-graph", env)) throw new Error(`Graph only calls https addresses; the site's address is ${site}. Set NEXT_PUBLIC_SITE_URL, or use the fakes locally.`)
  return { notificationUrl: `${site}/api/webhooks/graph`, lifecycleUrl: `${site}/api/webhooks/graph/lifecycle` }
}

type GraphSubscriptionResponse = { id: string; resource?: string; expirationDateTime: string }

export type EnsureSubscriptionsOptions = {
  graph: GraphClient
  teamId: string
  channelIds: string[]
  clientState: string
  store: SubscriptionStore
  notificationUrl: string
  lifecycleUrl: string
  now?: Date
  signal?: AbortSignal
}

export type SubscriptionCounts = { created: number; renewed: number; replaced: number; deleted: number; kept: number }

const expiry = (now: Date) => new Date(now.getTime() + SUBSCRIPTION_MINUTES * 60_000)

export async function createSubscription({ graph, resource, clientState, notificationUrl, lifecycleUrl, store, now, signal }: { graph: GraphClient; resource: string; clientState: string; notificationUrl: string; lifecycleUrl: string; store: SubscriptionStore; now: Date; signal?: AbortSignal }): Promise<GraphSubscriptionRow> {
  const body = { changeType: CHANGE_TYPES, notificationUrl, lifecycleNotificationUrl: lifecycleUrl, resource, includeResourceData: false, expirationDateTime: expiry(now).toISOString(), clientState }
  let created: GraphSubscriptionResponse
  try {
    created = await graph.post<GraphSubscriptionResponse>("/subscriptions", body, signal)
  } catch (error) {
    if (!(error instanceof GraphApiError) || error.status !== 409) throw error
    // One already exists for this resource (made before our row, or by another deployment): replace it
    const { value } = await graph.page<GraphSubscriptionResponse>("/subscriptions", { signal })
    for (const old of value.filter((s) => s.resource === resource)) await deleteSubscription(graph, store, old.id, signal)
    created = await graph.post<GraphSubscriptionResponse>("/subscriptions", body, signal)
  }
  const row = { id: created.id, resource, expiresAt: new Date(created.expirationDateTime), clientStateHash: clientStateHash(clientState) }
  await store.save(row)
  return row
}

export async function renewSubscription(graph: GraphClient, store: SubscriptionStore, row: GraphSubscriptionRow, now: Date, signal?: AbortSignal): Promise<GraphSubscriptionRow> {
  const renewed = await graph.patch<GraphSubscriptionResponse>(`/subscriptions/${encodeURIComponent(row.id)}`, { expirationDateTime: expiry(now).toISOString() }, signal)
  const next = { ...row, expiresAt: new Date(renewed?.expirationDateTime ?? expiry(now)) }
  await store.save(next)
  return next
}

/** Deletes it in Graph (gone already is fine) and drops our row */
export async function deleteSubscription(graph: GraphClient, store: SubscriptionStore, id: string, signal?: AbortSignal) {
  try {
    await graph.delete(`/subscriptions/${encodeURIComponent(id)}`, signal)
  } catch (error) {
    if (!(error instanceof GraphApiError) || error.status !== 404) throw error
  }
  await store.remove(id)
}

export async function ensureSubscriptions(options: EnsureSubscriptionsOptions): Promise<SubscriptionCounts> {
  const { graph, teamId, channelIds, clientState, store, notificationUrl, lifecycleUrl, signal } = options
  const now = options.now ?? new Date()
  const counts: SubscriptionCounts = { created: 0, renewed: 0, replaced: 0, deleted: 0, kept: 0 }
  const hash = clientStateHash(clientState)
  const wanted = new Map(channelIds.map((channelId) => [subscriptionResource(teamId, channelId), channelId]))
  const rows = await store.list()

  for (const row of rows) {
    if (!wanted.has(row.resource)) {
      await deleteSubscription(graph, store, row.id, signal)
      counts.deleted++
    }
  }
  for (const resource of wanted.keys()) {
    const mine = rows.filter((row) => row.resource === resource)
    const current = mine.find((row) => row.clientStateHash === hash)
    for (const stale of mine.filter((row) => row !== current)) {
      // Made with an older secret: notifications for it would be dropped
      await deleteSubscription(graph, store, stale.id, signal)
      counts.replaced++
    }
    if (!current) {
      await createSubscription({ graph, resource, clientState, notificationUrl, lifecycleUrl, store, now, signal })
      counts.created++
      continue
    }
    if (current.expiresAt.getTime() - now.getTime() > RENEW_WITHIN_MS) {
      counts.kept++
      continue
    }
    try {
      await renewSubscription(graph, store, current, now, signal)
      counts.renewed++
    } catch (error) {
      if (!(error instanceof GraphApiError) || error.status !== 404) throw error
      // Expired or removed in Graph: make a new one
      await store.remove(current.id)
      await createSubscription({ graph, resource, clientState, notificationUrl, lifecycleUrl, store, now, signal })
      counts.created++
    }
  }
  return counts
}
