import { randomBytes, randomUUID } from "node:crypto"
import type { FakeService } from "../../fakes/types"
import { svixSignature } from "../svix"

/**
 * The Resend fake, mounted at /resend (research/resend.md §7). The app's sends reach it when
 * RESEND_BASE_URL=http://127.0.0.1:3999/resend (the SDK reads it once, at load; JACK_FAKES can't switch
 * it). It reproduces:
 * - auth: a Bearer re_… key (401 missing_api_key), a User-Agent (403), and send-only keys named
 *   re_send_… that get 401 restricted_api_key on every read, like the production key;
 * - POST /emails and /emails/batch (strict or permissive validation, at most 100, Idempotency-Key kept
 *   for the fake's life, 10 requests a second, 100 recipients a UTC day), GET /emails and /emails/:id;
 * - the webhook sender: POST /_fake/webhooks signs (Svix) and posts the delivery events of every email
 *   sent so far to a local URL, with the outcome picked by address like Resend's test inboxes
 *   (delivered@, bounced@, complained@, suppressed@ resend.dev, plus delayed@ and clicked@; +labels
 *   allowed), and knobs for duplicates and out-of-order delivery.
 */

type Sent = { id: string; to: string[]; subject: string; from: string; createdAt: Date; lastEvent: string; delivered: boolean }

const DAILY_LIMIT = 100
const PER_SECOND = 10

const fail = (status: number, name: string, message: string, headers: Record<string, string> = {}) => Response.json({ name, statusCode: status, message }, { status, headers })

/** Postgres-style, the way Resend's API writes times */
const pgTime = (date: Date) => date.toISOString().replace("T", " ").replace("Z", "+00")

/** The events Resend would send for one recipient, from its test-inbox name */
export function outcomeFor(address: string): string[] {
  const local = address.toLowerCase().split("@")[0].split("+")[0]
  if (local === "bounced") return ["email.sent", "email.bounced"]
  if (local === "complained") return ["email.sent", "email.delivered", "email.complained"]
  if (local === "suppressed") return ["email.suppressed"]
  if (local === "delayed") return ["email.sent", "email.delivery_delayed", "email.bounced"]
  if (local === "clicked") return ["email.sent", "email.delivered", "email.opened", "email.clicked"]
  return ["email.sent", "email.delivered"]
}

/** The extra object an event type carries */
function extra(type: string): Record<string, unknown> {
  if (type === "email.bounced") return { bounce: { type: "Permanent", subType: "General", message: "The recipient's email address does not exist.", diagnosticCode: ["smtp; 550 5.1.1 user unknown"] } }
  if (type === "email.suppressed") return { suppressed: { type: "OnAccountSuppressionList", message: "This address is on the account's suppression list." } }
  if (type === "email.failed") return { failed: { reason: "reached_daily_quota" } }
  // A click carries the reader's IP and browser; the app must drop them
  if (type === "email.clicked") return { click: { link: "https://www.longhornsimracing.org/events?utm_source=email&token=abc123", timestamp: new Date().toISOString(), ipAddress: "203.0.113.7", userAgent: "Mozilla/5.0 (fake)" } }
  return {}
}

function localTarget(raw: unknown): URL | null {
  if (typeof raw !== "string") return null
  try {
    const url = new URL(raw)
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url : null
  } catch {
    return null
  }
}

const recipients = (to: unknown): string[] | null => {
  const list = Array.isArray(to) ? to : typeof to === "string" ? [to] : null
  return list && list.length && list.length <= 50 && list.every((a) => typeof a === "string" && /^[^\s@]+@[^\s@]+$/.test(a.replace(/^.*<|>$/g, ""))) ? list : null
}

export const resendFake: FakeService = {
  id: "resend",
  create() {
    const sent: Sent[] = []
    const idempotency = new Map<string, { body: string; response: { status: number; json: unknown } }>()
    let delivered = 0
    let windowStart = 0
    let windowCount = 0
    let quotaDay = ""
    let quotaUsed = 0

    /** Auth, User-Agent and the rate limit; null when the request may go on */
    const gate = (request: Request, { read = false } = {}): Response | null => {
      const auth = request.headers.get("authorization") ?? ""
      const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
      if (!key) return fail(401, "missing_api_key", "Missing API key in the authorization header. Include the following header in the request: Authorization: Bearer YOUR_API_KEY")
      if (!key.startsWith("re_")) return fail(400, "validation_error", "API key is invalid")
      if (!request.headers.get("user-agent")) return fail(403, "validation_error", "Missing User-Agent header (error code 1010)")
      const now = Date.now()
      if (now - windowStart >= 1000) {
        windowStart = now
        windowCount = 0
      }
      windowCount += 1
      if (windowCount > PER_SECOND) {
        return fail(429, "rate_limit_exceeded", "Too many requests. You can only make 10 requests per second.", { "ratelimit-limit": String(PER_SECOND), "ratelimit-remaining": "0", "ratelimit-reset": "1", "retry-after": "1" })
      }
      if (read && key.startsWith("re_send_")) return fail(401, "restricted_api_key", "This API key is restricted to only send emails")
      return null
    }

    /** Counts recipients against the UTC day's limit; false when over */
    const takeQuota = (count: number) => {
      const day = new Date().toISOString().slice(0, 10)
      if (day !== quotaDay) {
        quotaDay = day
        quotaUsed = 0
      }
      if (quotaUsed + count > DAILY_LIMIT) return false
      quotaUsed += count
      return true
    }

    /** Answers a repeated Idempotency-Key the way Resend does */
    const idempotent = async (request: Request, run: (body: string) => Promise<{ status: number; json: unknown }>): Promise<Response> => {
      const key = request.headers.get("idempotency-key")
      const body = await request.text()
      if (key !== null && (key.length < 1 || key.length > 256)) return fail(400, "invalid_idempotency_key", "The key must be between 1-256 chars.")
      const seen = key ? idempotency.get(key) : undefined
      if (seen) return seen.body === body ? Response.json(seen.response.json, { status: seen.response.status }) : fail(409, "invalid_idempotent_request", "Same idempotency key used with a different request payload.")
      const response = await run(body)
      if (key && response.status < 300) idempotency.set(key, { body, response })
      return Response.json(response.json, { status: response.status })
    }

    const record = (email: { to: string[]; subject: string; from: string }) => {
      const item: Sent = { id: randomUUID(), ...email, createdAt: new Date(), lastEvent: "sent", delivered: false }
      sent.push(item)
      return item
    }

    type Problem = { status: number; json: unknown }
    const invalid = (email: unknown): string | null => {
      const e = (email ?? {}) as Record<string, unknown>
      if (typeof e.from !== "string" || !e.from) return "Missing `from` field."
      if (!recipients(e.to)) return "Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format."
      if (typeof e.subject !== "string") return "Missing `subject` field."
      return null
    }
    const quotaProblem = (): Problem => ({ status: 429, json: { name: "daily_quota_exceeded", statusCode: 429, message: "You have reached your daily email sending quota." } })
    const toList = (email: unknown) => recipients((email as { to: unknown }).to)!.map((a) => a.replace(/^.*<|>$/g, "").toLowerCase())

    return [
      {
        method: "POST",
        path: "/emails",
        handle: async (request) =>
          gate(request) ??
          idempotent(request, async (body) => {
            const email = JSON.parse(body || "{}") as Record<string, unknown>
            const problem = invalid(email)
            if (problem) return { status: 422, json: { name: "missing_required_field", statusCode: 422, message: problem } }
            const to = toList(email)
            if (!takeQuota(to.length)) return quotaProblem()
            return { status: 200, json: { id: record({ to, subject: String(email.subject), from: String(email.from) }).id } }
          }),
      },
      {
        method: "POST",
        path: "/emails/batch",
        handle: async (request) =>
          gate(request) ??
          idempotent(request, async (body) => {
            const emails = JSON.parse(body || "[]") as unknown[]
            if (!Array.isArray(emails) || emails.length === 0) return { status: 422, json: { name: "invalid_parameter", statusCode: 422, message: "The request body must be an array of emails." } }
            if (emails.length > 100) return { status: 422, json: { name: "invalid_parameter", statusCode: 422, message: "Too many emails: a batch takes at most 100." } }
            const permissive = request.headers.get("x-batch-validation") === "permissive"
            const problems = emails.map((email, index) => ({ index, message: invalid(email) })).filter((p): p is { index: number; message: string } => p.message !== null)
            if (problems.length && !permissive) return { status: 422, json: { name: "validation_error", statusCode: 422, message: problems[0].message } }
            const valid = emails.filter((_, index) => !problems.some((p) => p.index === index))
            if (!takeQuota(valid.reduce<number>((n, email) => n + toList(email).length, 0))) return quotaProblem()
            const data = valid.map((email) => ({ id: record({ to: toList(email), subject: String((email as { subject: unknown }).subject), from: String((email as { from: unknown }).from) }).id }))
            return { status: 200, json: permissive ? { data, errors: problems } : { data } }
          }),
      },
      {
        method: "GET",
        path: "/emails",
        handle: (request) => {
          const blocked = gate(request, { read: true })
          if (blocked) return blocked
          const params = new URL(request.url).searchParams
          const limit = Number(params.get("limit") ?? 20)
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(422, "invalid_parameter", "limit must be between 1 and 100")
          const after = params.get("after")
          const before = params.get("before")
          if (after && before) return fail(422, "invalid_parameter", "Use either after or before, not both")
          const newestFirst = [...sent].reverse()
          let start = 0
          let end = newestFirst.length
          if (after) start = newestFirst.findIndex((e) => e.id === after) + 1
          if (before) end = Math.max(0, newestFirst.findIndex((e) => e.id === before))
          const slice = before ? newestFirst.slice(Math.max(start, end - limit), end) : newestFirst.slice(start, start + limit)
          const hasMore = before ? end - limit > 0 : start + limit < newestFirst.length
          return Response.json({
            object: "list",
            has_more: hasMore,
            data: slice.map((e) => ({ id: e.id, to: e.to, from: e.from, subject: e.subject, created_at: pgTime(e.createdAt), last_event: e.lastEvent, scheduled_at: null })),
          })
        },
      },
      {
        method: "GET",
        path: "/emails/:id",
        handle: (request, { params }) => {
          const blocked = gate(request, { read: true })
          if (blocked) return blocked
          const email = sent.find((e) => e.id === params.id)
          if (!email) return fail(404, "not_found", "Email not found")
          return Response.json({ object: "email", id: email.id, to: email.to, from: email.from, subject: email.subject, created_at: pgTime(email.createdAt), last_event: email.lastEvent, scheduled_at: null, tags: [] })
        },
      },
      {
        // { target, secret?, duplicate?, outOfOrder? }: posts the events of every email not delivered yet, one per recipient, signed with the secret (RESEND_WEBHOOK_SECRET by default)
        method: "POST",
        path: "/_fake/webhooks",
        handle: async (request) => {
          const body = (await request.json().catch(() => ({}))) as { target?: string; secret?: string; duplicate?: boolean; outOfOrder?: boolean }
          const target = localTarget(body.target)
          if (!target) return Response.json({ fake: true, error: "target must be an http URL on this machine, e.g. http://localhost:3000/api/webhooks/resend" }, { status: 400 })
          const secret = body.secret ?? process.env.RESEND_WEBHOOK_SECRET
          if (!secret) return Response.json({ fake: true, error: "No secret: pass one, or set RESEND_WEBHOOK_SECRET for the fakes server" }, { status: 400 })

          let posted = 0
          let refused = 0
          for (const email of sent.filter((e) => !e.delivered)) {
            for (const to of email.to) {
              const types = outcomeFor(to)
              const events = types.map((type, i) => {
                const at = new Date(email.createdAt.getTime() + (i + 1) * 1000).toISOString()
                return { svixId: `msg_fake${randomBytes(9).toString("hex")}`, body: JSON.stringify({ type, created_at: at, data: { email_id: email.id, created_at: email.createdAt.toISOString(), from: email.from, to: [to], subject: email.subject, tags: { source: "fake" }, ...extra(type) } }) }
              })
              const order = body.outOfOrder ? [...events].reverse() : events
              for (const event of body.duplicate ? order.flatMap((e) => [e, e]) : order) {
                const ts = Math.floor(Date.now() / 1000)
                const send = () =>
                  fetch(target, { method: "POST", headers: { "content-type": "application/json", "svix-id": event.svixId, "svix-timestamp": String(ts), "svix-signature": svixSignature(secret, event.svixId, ts, event.body) }, body: event.body })
                // Like Svix: a non-2xx answer is retried (once here), with the same svix-id
                const response = await send().then((r) => (r.ok ? r : send()))
                if (response.ok) posted += 1
                else refused += 1
              }
              email.lastEvent = types[types.length - 1].replace("email.", "")
            }
            email.delivered = true
            delivered += 1
          }
          return Response.json({ ok: refused === 0, emails: delivered, posted, refused })
        },
      },
    ]
  },
}
