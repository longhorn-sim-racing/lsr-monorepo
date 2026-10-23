import { createHash, timingSafeEqual } from "node:crypto"
import { GraphApiError } from "../microsoft/graph"
import type { TeamsConnection } from "./connector"
import { messagesPath, parseMessageResource, subscriptionResource, toTeamsMessage, type GraphChatMessage } from "./messages"
import type { SubscriptionStore, TeamsStore } from "./store"
import { clientStateHash, createSubscription, renewSubscription, webhookUrls } from "./subscriptions"
import { syncTeams } from "./sync"

/**
 * What Graph's change notifications and lifecycle events do (design §12.8; research §4). The webhook
 * routes check each notification's clientState and answer 202 at once; this runs after the response.
 *
 * Basic notifications carry no signature, only the clientState we gave Graph, so that's checked in
 * constant time, and every notification must also name a subscription of ours, made with the current
 * secret, for a configured channel of our team. Notifications carry no data (includeResourceData is
 * off): each one makes us fetch the message, so a forged one could at most make us re-read a message.
 * There's no message id to dedupe on; fetching and saving a message twice changes nothing.
 */

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest()

/** Constant time, whatever the lengths (both sides are hashed first) */
export function clientStateMatches(received: unknown, secret: string): boolean {
  if (typeof received !== "string" || !secret) return false
  return timingSafeEqual(digest(received), digest(secret))
}

export type GraphNotification = {
  subscriptionId?: string
  changeType?: string
  clientState?: string
  resource?: string
  tenantId?: string
  lifecycleEvent?: string
}

/** The `value` array of a notification body; null when it isn't one */
export function parseNotifications(raw: string): GraphNotification[] | null {
  try {
    const body = JSON.parse(raw) as { value?: unknown }
    if (!Array.isArray(body?.value)) return null
    return body.value.filter((item): item is GraphNotification => !!item && typeof item === "object").slice(0, 200)
  } catch {
    return null
  }
}

export type NotificationDeps = { connection: TeamsConnection; teams: TeamsStore; subscriptions: SubscriptionStore; now?: () => Date; signal?: AbortSignal }

/** Ours: a subscription we hold, made with the current secret */
async function ours(n: GraphNotification, deps: NotificationDeps) {
  if (!n.subscriptionId) return null
  const row = await deps.subscriptions.find(n.subscriptionId)
  return row && row.clientStateHash === clientStateHash(deps.connection.clientState) ? row : null
}

/** Saves (or purges) the messages a batch of change notifications points at. Returns what it did */
export async function processMessageNotifications(notifications: GraphNotification[], deps: NotificationDeps): Promise<{ saved: number; purged: number; dropped: number }> {
  const { connection, teams } = deps
  const now = deps.now ?? (() => new Date())
  const result = { saved: 0, purged: 0, dropped: 0 }
  const seen = new Set<string>()
  for (const n of notifications) {
    const target = parseMessageResource(n.resource)
    const key = `${n.changeType}:${n.resource}`
    if (!target || seen.has(key) || target.teamId !== connection.teamId || !connection.channelIds.includes(target.channelId) || !(await ours(n, deps))) {
      result.dropped++
      continue
    }
    seen.add(key)
    const id = target.replyId ?? target.messageId
    if (n.changeType === "deleted") {
      if (await teams.purgeMessage(id, now())) result.purged++
      continue
    }
    const path = `${messagesPath(connection.teamId, target.channelId)}/${encodeURIComponent(target.messageId)}${target.replyId ? `/replies/${encodeURIComponent(target.replyId)}` : ""}`
    let message: GraphChatMessage
    try {
      message = await connection.graph.get<GraphChatMessage>(path, { signal: deps.signal })
    } catch (error) {
      if (error instanceof GraphApiError && error.status === 404) {
        if (await teams.purgeMessage(id, now())) result.purged++
        continue
      }
      throw error
    }
    const row = toTeamsMessage(message, target.channelId, target.replyId ? target.messageId : null)
    if (!row) continue
    // A notification can come before the daily sync has seen the channel
    if (!(await teams.channel(target.channelId))) await teams.saveChannel({ id: target.channelId, teamId: connection.teamId, name: target.channelId }, now())
    await teams.saveMessage(row)
    if (row.deletedAt) result.purged++
    else result.saved++
  }
  return result
}

/**
 * Lifecycle events: reauthorizationRequired renews the subscription; subscriptionRemoved makes a new one
 * and reconciles the channel; missed (Graph doesn't send it for chat messages yet) reconciles the channel
 */
export async function processLifecycleEvents(events: GraphNotification[], deps: NotificationDeps & { deadline: number }): Promise<{ renewed: number; recreated: number; reconciled: number; dropped: number }> {
  const { connection } = deps
  const now = deps.now ?? (() => new Date())
  const result = { renewed: 0, recreated: 0, reconciled: 0, dropped: 0 }
  const handled = new Set<string>()
  for (const event of events) {
    const row = await ours(event, deps)
    const channelId = row ? connection.channelIds.find((id) => subscriptionResource(connection.teamId, id) === row.resource) : undefined
    if (!row || !channelId || handled.has(`${event.lifecycleEvent}:${row.id}`)) {
      result.dropped++
      continue
    }
    handled.add(`${event.lifecycleEvent}:${row.id}`)
    if (event.lifecycleEvent === "reauthorizationRequired") {
      await renewSubscription(connection.graph, deps.subscriptions, row, now(), deps.signal)
      result.renewed++
      continue
    }
    if (event.lifecycleEvent === "subscriptionRemoved") {
      await deps.subscriptions.remove(row.id)
      const { notificationUrl, lifecycleUrl } = webhookUrls()
      await createSubscription({ graph: connection.graph, resource: row.resource, clientState: connection.clientState, notificationUrl, lifecycleUrl, store: deps.subscriptions, now: now(), signal: deps.signal })
      result.recreated++
    } else if (event.lifecycleEvent !== "missed") {
      result.dropped++
      continue
    }
    // Catch up on what may have been missed meanwhile: this channel's delta, from its stored link
    await syncTeams({ graph: connection.graph, teamId: connection.teamId, channelIds: [channelId], store: { ...deps.teams, dropOtherChannels: async () => ({ channels: 0, messages: 0 }) }, cursor: null, signal: deps.signal ?? new AbortController().signal, deadline: deps.deadline })
    result.reconciled++
  }
  return result
}
