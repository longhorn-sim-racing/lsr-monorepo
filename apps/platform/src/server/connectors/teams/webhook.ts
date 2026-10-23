import { runAfterResponse } from "@/server/after-response"
import { teamsConnector } from "./connector"
import { clientStateMatches, parseNotifications, processLifecycleEvents, processMessageNotifications, type GraphNotification } from "./notifications"
import { prismaSubscriptionStore, prismaTeamsStore } from "./store"

/**
 * The two Graph webhook routes (/api/webhooks/graph and /api/webhooks/graph/lifecycle; design §12.8,
 * research §4). Graph checks an endpoint by posting `?validationToken=…` and wants it back as plain
 * text within 10 s; it wants every notification acknowledged within 3 s, so the routes only check and
 * answer, and the work runs after the response.
 *
 * - Fails closed: without MS_GRAPH_CLIENT_STATE every request is refused (503), validation included.
 * - The raw body is read once and parsed here; nothing in it is logged.
 * - Each notification's clientState is compared in constant time; mismatches are dropped (and counted
 *   in the log, without their content). Graph's basic notifications carry no signature or timestamp,
 *   so there's no time window to check; the processing (notifications.ts) also requires a subscription
 *   of ours, and fetches the message itself.
 * - While the Teams connector is off or not set up, valid notifications are acknowledged and dropped.
 */

/** Graph batches notifications; a real batch is far smaller */
const MAX_BODY_CHARS = 1_000_000
/** Graph's validation tokens are short; anything longer isn't one */
const MAX_VALIDATION_TOKEN_CHARS = 1_024
/** The work after the response stops well inside the route's 60 s */
const WORK_BUDGET_MS = 45_000

export type GraphWebhookKind = "notifications" | "lifecycle"

export async function handleGraphWebhook(request: Request, kind: GraphWebhookKind, env: Record<string, string | undefined> = process.env): Promise<Response> {
  const secret = env.MS_GRAPH_CLIENT_STATE?.trim()
  if (!secret) return new Response(null, { status: 503 })

  const token = new URL(request.url).searchParams.get("validationToken")
  if (token !== null) {
    if (!token || token.length > MAX_VALIDATION_TOKEN_CHARS) return new Response(null, { status: 400 })
    // Echoed as plain text, never HTML: it's Graph's opaque value
    return new Response(token, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" } })
  }

  const raw = await request.text()
  if (raw.length > MAX_BODY_CHARS) return new Response(null, { status: 413 })
  const notifications = parseNotifications(raw)
  if (!notifications) return new Response(null, { status: 400 })
  const valid = notifications.filter((n) => clientStateMatches(n.clientState, secret))
  if (valid.length < notifications.length) console.warn(`[teams] Dropped ${notifications.length - valid.length} Graph ${kind === "lifecycle" ? "lifecycle events" : "notifications"} with the wrong clientState`)
  if (valid.length) {
    const started = Date.now()
    runAfterResponse(() => processGraphWebhook(valid, kind, started + WORK_BUDGET_MS), `[teams] Processing Graph ${kind} failed:`)
  }
  return new Response(null, { status: 202 })
}

/** The work after the response: only while the Teams connector is on and set up */
export async function processGraphWebhook(valid: GraphNotification[], kind: GraphWebhookKind, deadline: number) {
  const connection = await teamsConnector.client()
  if (!connection) return
  const signal = AbortSignal.timeout(Math.max(1_000, deadline - Date.now()))
  const deps = { connection, teams: prismaTeamsStore(), subscriptions: prismaSubscriptionStore(), signal }
  const result = kind === "lifecycle" ? await processLifecycleEvents(valid, { ...deps, deadline }) : await processMessageNotifications(valid, deps)
  console.info(`[teams] Graph ${kind}: ${Object.entries(result).map(([key, value]) => `${key} ${value}`).join(", ")}`)
}
