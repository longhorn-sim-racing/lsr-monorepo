import { createHash, createHmac, timingSafeEqual } from "node:crypto"

/**
 * EventSub webhooks (#188, design §12.2; research/twitch.md §4): the signature, the replay window and
 * the message shapes. Pure, so the webhook route, the fake that sends messages and the tests share it.
 *
 * Twitch signs `message id + timestamp + raw body` with HMAC-SHA256 under the secret given when the
 * subscription was made (TWITCH_EVENTSUB_SECRET) and sends `sha256=<hex>`. Messages older than 10
 * minutes are refused, and the route skips a message id it has handled before (a resend).
 */

export const EVENTSUB_HEADERS = {
  id: "twitch-eventsub-message-id",
  retry: "twitch-eventsub-message-retry",
  type: "twitch-eventsub-message-type",
  signature: "twitch-eventsub-message-signature",
  timestamp: "twitch-eventsub-message-timestamp",
  subscriptionType: "twitch-eventsub-subscription-type",
  subscriptionVersion: "twitch-eventsub-subscription-version",
} as const

/** How old (or how far ahead) a message's timestamp may be */
export const EVENTSUB_WINDOW_MS = 10 * 60_000

export type EventSubMessageType = "notification" | "webhook_callback_verification" | "revocation"

export function eventSubSignature(secret: string, messageId: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(messageId + timestamp + rawBody, "utf8").digest("hex")}`
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest()

/** Constant time, over equal-length buffers whatever the inputs' lengths (both sides are hashed first) */
function same(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b))
}

/**
 * An RFC 3339 time with up to 9 fractional digits (Twitch sends nanoseconds) in epoch ms, or NaN. The
 * fraction is cut to milliseconds first: Node reads 9 digits, but that isn't a promise of the spec
 */
export function parseEventSubTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return Number.NaN
  return Date.parse(value.replace(/(\.\d{3})\d+/, "$1"))
}

export type EventSubCheck =
  | { ok: true; id: string; type: EventSubMessageType | (string & {}); at: Date; retry: boolean }
  | { ok: false; reason: "no_secret" | "missing_headers" | "bad_timestamp" | "stale_timestamp" | "bad_signature" }

/** Checks a delivery: our secret's signature over the exact raw body, within the replay window. Fails closed without a secret */
export function verifyEventSub(headers: Headers, rawBody: string, { secret, nowMs = Date.now() }: { secret: string | undefined; nowMs?: number }): EventSubCheck {
  if (!secret?.trim()) return { ok: false, reason: "no_secret" }
  const id = headers.get(EVENTSUB_HEADERS.id)
  const timestamp = headers.get(EVENTSUB_HEADERS.timestamp)
  const signature = headers.get(EVENTSUB_HEADERS.signature)
  const type = headers.get(EVENTSUB_HEADERS.type)
  if (!id || !timestamp || !signature || !type) return { ok: false, reason: "missing_headers" }
  const at = parseEventSubTimestamp(timestamp)
  if (Number.isNaN(at)) return { ok: false, reason: "bad_timestamp" }
  // The signature first, so an unsigned request learns nothing from which check failed
  if (!same(signature.trim(), eventSubSignature(secret, id, timestamp, rawBody))) return { ok: false, reason: "bad_signature" }
  if (Math.abs(nowMs - at) > EVENTSUB_WINDOW_MS) return { ok: false, reason: "stale_timestamp" }
  return { ok: true, id, type, at: new Date(at), retry: (headers.get(EVENTSUB_HEADERS.retry) ?? "0") !== "0" }
}

/** The subscription part of every message */
export type EventSubSubscription = {
  id: string
  type: string
  version: string
  status: string
  condition: { broadcaster_user_id?: string }
  transport?: { method: string; callback?: string }
  created_at?: string
  cost?: number
}

export type StreamOnlineEvent = {
  /** The stream id: the same id as Get Streams' and a VOD's stream_id */
  id: string
  broadcaster_user_id: string
  broadcaster_user_login: string
  broadcaster_user_name: string
  /** live, playlist, watch_party, premiere or rerun: only "live" is a stream */
  type: string
  started_at: string
}

export type StreamOfflineEvent = {
  broadcaster_user_id: string
  broadcaster_user_login: string
  broadcaster_user_name: string
  /** Listed in the reference and in its example, but not every message may have it */
  id?: string
}

/** A message's body, by its type. Parsed leniently: Twitch adds fields without notice */
export type EventSubBody =
  | { kind: "challenge"; challenge: string; subscription: EventSubSubscription }
  | { kind: "online"; subscription: EventSubSubscription; event: StreamOnlineEvent }
  | { kind: "offline"; subscription: EventSubSubscription; event: StreamOfflineEvent }
  | { kind: "revocation"; subscription: EventSubSubscription }
  | { kind: "other"; subscription: EventSubSubscription | null }

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" ? value : "")

/** The body of a verified message, or null when it isn't the JSON its type promises */
export function parseEventSubBody(type: string, rawBody: string): EventSubBody | null {
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return null
  }
  if (!record(body) || !record(body.subscription)) return null
  const subscription = body.subscription as EventSubSubscription
  if (!text(subscription.type)) return null
  if (type === "webhook_callback_verification") return text(body.challenge) ? { kind: "challenge", challenge: text(body.challenge), subscription } : null
  if (type === "revocation") return { kind: "revocation", subscription }
  if (type !== "notification" || !record(body.event)) return { kind: "other", subscription }
  const event = body.event
  if (subscription.type === "stream.online") {
    if (!text(event.id) || !text(event.broadcaster_user_id) || Number.isNaN(Date.parse(text(event.started_at)))) return null
    return { kind: "online", subscription, event: event as StreamOnlineEvent }
  }
  if (subscription.type === "stream.offline") {
    if (!text(event.broadcaster_user_id)) return null
    return { kind: "offline", subscription, event: event as StreamOfflineEvent }
  }
  return { kind: "other", subscription }
}
