import { CANONICAL_SITE_URL } from "@/lib/site-url"
import { TwitchApiError, type TwitchApi } from "./client"

/**
 * Setting up the EventSub subscriptions (#188, design §12.2), for scripts/twitch-eventsub.ts: list what
 * Twitch has, plan what to create or replace, and do it. Subscriptions need the app token. Only ours
 * are touched: the club channel's stream.online and stream.offline to our exact callback. Ones to other
 * callbacks are listed and left alone.
 */

export const EVENTSUB_TYPES = ["stream.online", "stream.offline"] as const
/** The production callback, exactly: Twitch follows no redirects */
export const PRODUCTION_CALLBACK = `${CANONICAL_SITE_URL}/api/webhooks/twitch`

export type Subscription = { id: string; type: string; status: string; callback: string; condition: { broadcaster_user_id?: string }; cost?: number }
type ListPage = { data: (Omit<Subscription, "callback"> & { transport?: { callback?: string } })[]; total: number; total_cost: number; max_total_cost: number; pagination?: { cursor?: string } }

/** Statuses that will deliver (or will once the challenge is answered) */
const LIVE = new Set(["enabled", "webhook_callback_verification_pending"])

export type SubscriptionPlan = {
  keep: Subscription[]
  /** Ours, to our callback, but failed or revoked: deleted before re-creating */
  remove: Subscription[]
  create: (typeof EVENTSUB_TYPES)[number][]
  /** Subscriptions to another callback (an old host, a tunnel): left alone */
  elsewhere: Subscription[]
}

export async function listSubscriptions(api: TwitchApi, token: string, broadcasterId: string): Promise<{ subscriptions: Subscription[]; totalCost: number; maxTotalCost: number }> {
  const subscriptions: Subscription[] = []
  let after: string | undefined
  let page: ListPage
  do {
    page = await api.helix<ListPage>("/eventsub/subscriptions", { token, params: { user_id: broadcasterId, after } })
    for (const sub of page.data) subscriptions.push({ id: sub.id, type: sub.type, status: sub.status, condition: sub.condition, cost: sub.cost, callback: sub.transport?.callback ?? "" })
    after = page.data.length ? page.pagination?.cursor : undefined
  } while (after)
  return { subscriptions, totalCost: page.total_cost, maxTotalCost: page.max_total_cost }
}

/** What to do so the club channel has exactly one live subscription of each type to `callback` */
export function planSubscriptions(existing: Subscription[], callback: string, broadcasterId: string): SubscriptionPlan {
  const plan: SubscriptionPlan = { keep: [], remove: [], create: [], elsewhere: [] }
  const ours = existing.filter((sub) => sub.condition.broadcaster_user_id === broadcasterId && (EVENTSUB_TYPES as readonly string[]).includes(sub.type))
  plan.elsewhere = ours.filter((sub) => sub.callback !== callback)
  for (const type of EVENTSUB_TYPES) {
    const here = ours.filter((sub) => sub.type === type && sub.callback === callback)
    const live = here.find((sub) => LIVE.has(sub.status))
    if (live) plan.keep.push(live)
    else plan.create.push(type)
    plan.remove.push(...here.filter((sub) => sub !== live))
  }
  return plan
}

/** Carries out a plan: deletes, then creates (a 409 means it exists already) */
export async function applySubscriptionPlan(api: TwitchApi, token: string, plan: SubscriptionPlan, { callback, secret, broadcasterId }: { callback: string; secret: string; broadcasterId: string }): Promise<{ removed: number; created: string[] }> {
  for (const sub of plan.remove) await api.helix("/eventsub/subscriptions", { token, method: "DELETE", params: { id: sub.id } })
  const created: string[] = []
  for (const type of plan.create) {
    try {
      await api.helix("/eventsub/subscriptions", { token, method: "POST", body: { type, version: "1", condition: { broadcaster_user_id: broadcasterId }, transport: { method: "webhook", callback, secret } } })
      created.push(type)
    } catch (error) {
      if (!(error instanceof TwitchApiError && error.status === 409)) throw error
    }
  }
  return { removed: plan.remove.length, created }
}

/** Why a callback can't be used: production's exact URL only, unless `local` (then any http(s) URL) */
export function callbackProblem(callback: string, { local }: { local: boolean }): string | null {
  let url: URL
  try {
    url = new URL(callback)
  } catch {
    return `"${callback}" isn't a URL.`
  }
  if (local) return url.protocol === "https:" || url.protocol === "http:" ? null : "The callback must be http(s)."
  if (callback !== PRODUCTION_CALLBACK) return `Only ${PRODUCTION_CALLBACK} is allowed (Twitch follows no redirects, and previews change). Pass --local to use ${callback} (a dev server against the fakes, or a tunnel).`
  return null
}
