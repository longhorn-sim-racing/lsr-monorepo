import { createHash, createHmac, timingSafeEqual } from "node:crypto"

/**
 * Signs and checks the scheduler's requests (Jack 2.0, design §6; research/supabase-pg-cron.md §3.6).
 *
 * pg_cron's scheduler.tick() posts to /api/cron/tick with `X-LSR-Timestamp` and
 * `X-LSR-Signature: v1=hex(HMAC_SHA256(secret, timestamp + "." + body))`, computed in SQL over the exact
 * body text pg_net sends. So routes check the raw request text, never JSON they parsed and re-serialized.
 * The dispatcher's hand-off to /api/admin/jack/run uses the same scheme with "run." in front of the signed
 * text, so a tick's signature can't be replayed against it.
 *
 * The secret itself never travels: pg_net's request queue is readable by every database role. Checks
 * fail closed: with no SCHEDULER_SIGNING_SECRET nothing verifies. SCHEDULER_SIGNING_SECRET_PREVIOUS is
 * accepted too, while rotating.
 */

export const SCHEDULER_TIMESTAMP_HEADER = "x-lsr-timestamp"
export const SCHEDULER_SIGNATURE_HEADER = "x-lsr-signature"

/** How far a request's timestamp may be from now, either way, in seconds */
export const SCHEDULER_SIGNATURE_WINDOW_SECONDS = 300

/** "tick": pg_cron's call (the SQL signs `ts.body`). "run": the dispatcher's hand-off (`run.ts.body`) */
export type SchedulerPurpose = "tick" | "run"

export type SchedulerVerifyResult =
  | { ok: true }
  | { ok: false; reason: "no_secret" | "missing_headers" | "bad_timestamp" | "stale_timestamp" | "bad_signature" }

type Env = Readonly<Record<string, string | undefined>>

/** The text that gets signed. The tick form must stay byte-for-byte what scheduler.tick() signs */
function signedText(purpose: SchedulerPurpose, timestamp: string, rawBody: string): string {
  return purpose === "tick" ? `${timestamp}.${rawBody}` : `${purpose}.${timestamp}.${rawBody}`
}

/** `v1=<64 hex>` for a request */
export function schedulerSignature(secret: string, timestamp: string, rawBody: string, purpose: SchedulerPurpose = "tick"): string {
  return `v1=${createHmac("sha256", secret).update(signedText(purpose, timestamp, rawBody), "utf8").digest("hex")}`
}

/** The secrets a request may be signed with, current first; blank values don't count */
export function schedulerSecrets(env: Env = process.env): string[] {
  return [env.SCHEDULER_SIGNING_SECRET, env.SCHEDULER_SIGNING_SECRET_PREVIOUS].filter((secret): secret is string => !!secret && secret.trim().length > 0)
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest()

/** Constant time, and over equal-length buffers whatever the inputs' lengths (both sides are hashed first) */
function same(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b))
}

/** Checks a signed request: a whole-second timestamp within the window and a signature from a current or previous secret */
export function verifySchedulerSignature({
  timestamp,
  signature,
  rawBody,
  purpose = "tick",
  nowMs = Date.now(),
  env = process.env,
}: {
  timestamp: string | null | undefined
  signature: string | null | undefined
  rawBody: string
  purpose?: SchedulerPurpose
  nowMs?: number
  env?: Env
}): SchedulerVerifyResult {
  const secrets = schedulerSecrets(env)
  if (secrets.length === 0) return { ok: false, reason: "no_secret" }
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" }
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" }
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SCHEDULER_SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: "stale_timestamp" }
  // Every secret is checked (no early exit), so timing doesn't say which one matched
  let match = false
  for (const secret of secrets) match = same(signature.trim(), schedulerSignature(secret, timestamp, rawBody, purpose)) || match
  return match ? { ok: true } : { ok: false, reason: "bad_signature" }
}

/** verifySchedulerSignature with the timestamp and signature taken from a request's headers */
export function verifySchedulerRequest(headers: Headers, rawBody: string, purpose: SchedulerPurpose, options: { nowMs?: number; env?: Env } = {}): SchedulerVerifyResult {
  return verifySchedulerSignature({
    timestamp: headers.get(SCHEDULER_TIMESTAMP_HEADER),
    signature: headers.get(SCHEDULER_SIGNATURE_HEADER),
    rawBody,
    purpose,
    ...options,
  })
}

/**
 * The body scheduler.tick() sends, as pg_net sends it: jsonb's text form, with keys ordered by length and
 * then bytes and `": "` / `", "` between them (not what JSON.stringify writes). For tests and `pnpm jack:tick --http`
 */
export function tickBody(timestampSeconds: number, nonce: string): string {
  return `{"ts": ${timestampSeconds}, "kind": "tick", "nonce": ${JSON.stringify(nonce)}}`
}

/** Headers for a request we sign ourselves (the hand-off, `pnpm jack:tick --http`), with the current secret. Throws when it isn't set */
export function signSchedulerRequest(rawBody: string, purpose: SchedulerPurpose, { nowMs = Date.now(), env = process.env }: { nowMs?: number; env?: Env } = {}): Record<string, string> {
  const [secret] = schedulerSecrets(env)
  if (!secret) throw new Error("SCHEDULER_SIGNING_SECRET isn't set")
  const timestamp = String(Math.floor(nowMs / 1000))
  return {
    "content-type": "application/json",
    [SCHEDULER_TIMESTAMP_HEADER]: timestamp,
    [SCHEDULER_SIGNATURE_HEADER]: schedulerSignature(secret, timestamp, rawBody, purpose),
  }
}
