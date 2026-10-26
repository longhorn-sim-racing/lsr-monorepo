import { randomBytes } from "node:crypto"
import Stripe from "stripe"
import type { FakeRoute, FakeService } from "../../fakes/types"
import { fixtureBalance, stripeFixtures, type FakeDispute, type FakePayout, type StripeFixtures } from "./fixtures"

/**
 * The Stripe fake, mounted at /stripe (research/stripe.md §7). The real SDK talks to it through
 * serviceFetch("stripe"), so its parsing, auto-pagination, error classes and retries all run:
 * - Auth like Stripe's: a Bearer restricted key; a missing or unknown one is a 401, an expired one a
 *   401 authentication_error. Each key has a set of Read grants; a route outside them is a 403 naming
 *   the permission, and so is EVERY write (POST, DELETE): that's how the tests prove Jack never writes.
 * - Lists like Stripe's: the envelope, limit 1-100, starting_after or ending_before (not both),
 *   created[gte] style ranges, newest first. Unknown ids are 404 resource_missing. Request-Id on all.
 * - Test hooks: POST /_fake/fault (the next calls answer 429 or 5xx), POST /_fake/events (moves a payout
 *   or dispute on, and signs and sends its event to a local webhook URL).
 */

/** Keys the fake knows. Built from pieces so no scanner mistakes them for real keys */
export const STRIPE_FAKE_KEY = "rk_" + "test_" + "jackfakereadonly0000000001"
/** A key that has every Read but disputes */
export const STRIPE_FAKE_KEY_NO_DISPUTES = "rk_" + "test_" + "jackfakenodisputes00000001"
/** A key Stripe no longer accepts (rolled or expired) */
export const STRIPE_FAKE_KEY_EXPIRED = "rk_" + "test_" + "jackfakeexpired00000000001"

const ALL_READS = ["balance_read", "payout_read", "charge_read", "dispute_read"] as const
const GRANTS: Record<string, readonly string[]> = {
  [STRIPE_FAKE_KEY]: ALL_READS,
  [STRIPE_FAKE_KEY_NO_DISPUTES]: ALL_READS.filter((grant) => grant !== "dispute_read"),
}

type Item = { id: string; created: number }

const requestId = () => `req_fake${randomBytes(7).toString("hex")}`

function stripeError(status: number, error: { type: string; message: string; code?: string; param?: string }, headers: Record<string, string> = {}) {
  return Response.json({ error }, { status, headers: { "request-id": requestId(), ...headers } })
}

const ok = (body: unknown) => Response.json(body, { headers: { "request-id": requestId() } })

/** The key's grants, or the 401 Stripe would send */
function authorize(request: Request): readonly string[] | Response {
  const header = request.headers.get("authorization") ?? ""
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!key) return stripeError(401, { type: "invalid_request_error", message: "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth." })
  if (key === STRIPE_FAKE_KEY_EXPIRED) return stripeError(401, { type: "authentication_error", message: "This API key has expired." })
  const grants = GRANTS[key]
  if (!grants) return stripeError(401, { type: "invalid_request_error", message: `Invalid API Key provided: ${key.slice(0, 8)}****${key.slice(-4)}` })
  return grants
}

function forbidden(permission: string) {
  return stripeError(403, {
    type: "invalid_request_error",
    message: `The provided key does not have the required permissions for this endpoint. Having the 'rak_${permission}' permission would allow this request to continue.`,
  })
}

/** `created=123` or `created[gte]=123` style ranges, as the SDK encodes them */
function range(params: URLSearchParams, name: string): ((value: number) => boolean) | Response {
  const checks: ((value: number) => boolean)[] = []
  const exact = params.get(name)
  const number = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : null)
  if (exact !== null) {
    const n = number(exact)
    if (n === null) return stripeError(400, { type: "invalid_request_error", message: `Invalid integer: ${exact}`, param: name })
    checks.push((v) => v === n)
  }
  for (const op of ["gt", "gte", "lt", "lte"] as const) {
    const raw = params.get(`${name}[${op}]`)
    if (raw === null) continue
    const n = number(raw)
    if (n === null) return stripeError(400, { type: "invalid_request_error", message: `Invalid integer: ${raw}`, param: `${name}[${op}]` })
    checks.push(op === "gt" ? (v) => v > n : op === "gte" ? (v) => v >= n : op === "lt" ? (v) => v < n : (v) => v <= n)
  }
  return (value) => checks.every((check) => check(value))
}

/** One page of a list, the way Stripe pages: newest first (created, then id), from a cursor */
function page<T extends Item>(request: Request, url: URL, items: T[], filter: (item: T, params: URLSearchParams) => boolean | Response = () => true): Response {
  const params = url.searchParams
  const rawLimit = params.get("limit")
  const limit = rawLimit === null ? 10 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return stripeError(400, { type: "invalid_request_error", message: "This value must be between 1 and 100.", param: "limit" })
  const after = params.get("starting_after")
  const before = params.get("ending_before")
  if (after && before) return stripeError(400, { type: "invalid_request_error", message: "You may only specify one of these parameters: ending_before, starting_after." })
  const created = range(params, "created")
  if (created instanceof Response) return created

  const matching: T[] = []
  for (const item of [...items].sort((a, b) => b.created - a.created || b.id.localeCompare(a.id))) {
    if (!created(item.created)) continue
    const keep = filter(item, params)
    if (keep instanceof Response) return keep
    if (keep) matching.push(item)
  }

  let slice: T[]
  let hasMore: boolean
  if (after) {
    const at = matching.findIndex((item) => item.id === after)
    if (at < 0) return stripeError(400, { type: "invalid_request_error", message: `No such object: '${after}'`, param: "starting_after", code: "resource_missing" })
    slice = matching.slice(at + 1, at + 1 + limit)
    hasMore = at + 1 + limit < matching.length
  } else if (before) {
    const at = matching.findIndex((item) => item.id === before)
    if (at < 0) return stripeError(400, { type: "invalid_request_error", message: `No such object: '${before}'`, param: "ending_before", code: "resource_missing" })
    slice = matching.slice(Math.max(0, at - limit), at)
    hasMore = at - limit > 0
  } else {
    slice = matching.slice(0, limit)
    hasMore = limit < matching.length
  }
  return ok({ object: "list", url: url.pathname.replace(/^\/stripe/, ""), has_more: hasMore, data: slice })
}

const matches = (params: URLSearchParams, name: string, value: string | null) => {
  const wanted = params.get(name)
  return wanted === null || wanted === value
}

/** The id's object, or Stripe's 404 */
function retrieve<T extends { id: string }>(items: T[], id: string, noun: string): Response {
  const item = items.find((one) => one.id === id)
  return item ? ok(item) : stripeError(404, { type: "invalid_request_error", code: "resource_missing", param: "id", message: `No such ${noun}: '${id}'` })
}

type Fault = { status: number; times: number }

/** A webhook event for an object, as Stripe sends it */
function event(type: string, object: unknown, now: number) {
  return { id: `evt_fake${randomBytes(8).toString("hex")}`, object: "event", api_version: "2026-02-25.clover", created: now, type, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object } }
}

/** A loopback http URL, or null: the fake only ever posts events to this machine */
function localTarget(raw: unknown): URL | null {
  if (typeof raw !== "string") return null
  try {
    const url = new URL(raw)
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url : null
  } catch {
    return null
  }
}

export const stripeFake: FakeService = {
  id: "stripe",
  create() {
    const data: StripeFixtures = stripeFixtures()
    let fault: Fault | null = null

    /** A GET route that checks the key, its grant and any injected fault first */
    const read = (path: string, permission: string, handle: (request: Request, params: Record<string, string>, url: URL) => Response): FakeRoute => ({
      method: "GET",
      path,
      handle: (request, ctx) => {
        if (fault && fault.times > 0) {
          fault.times -= 1
          const status = fault.status
          if (status === 429) return stripeError(429, { type: "invalid_request_error", code: "rate_limit", message: "Too many requests hit the API too quickly." }, { "stripe-rate-limited-reason": "global-rate" })
          return stripeError(status, { type: "api_error", message: "Something went wrong on Stripe's end." }, { "stripe-should-retry": "true" })
        }
        const grants = authorize(request)
        if (grants instanceof Response) return grants
        if (!grants.includes(permission)) return forbidden(permission)
        return handle(request, ctx.params, new URL(request.url))
      },
    })

    return [
      read("/v1/balance", "balance_read", () => {
        const { available, pending } = fixtureBalance(data.transactions, data.payouts)
        return ok({
          object: "balance",
          livemode: false,
          available: [{ amount: available, currency: "usd", source_types: { card: available } }],
          pending: [{ amount: pending, currency: "usd", source_types: { card: pending } }],
          instant_available: null,
          connect_reserved: [{ amount: 0, currency: "usd" }],
        })
      }),
      read("/v1/payouts", "payout_read", (request, _params, url) =>
        page(request, url, data.payouts, (payout, params) => {
          const status = params.get("status")
          if (status === "in_transit") return stripeError(400, { type: "invalid_request_error", message: "Invalid status: must be one of pending, paid, failed, or canceled", param: "status" })
          const arrival = range(params, "arrival_date")
          if (arrival instanceof Response) return arrival
          return matches(params, "status", payout.status) && arrival(payout.arrival_date)
        }),
      ),
      read("/v1/payouts/:id", "payout_read", (_request, params) => retrieve(data.payouts, params.id, "payout")),
      read("/v1/balance_transactions", "balance_read", (request, _params, url) => {
        const payoutId = url.searchParams.get("payout")
        if (payoutId) {
          const payout = data.payouts.find((p) => p.id === payoutId)
          if (!payout) return stripeError(404, { type: "invalid_request_error", code: "resource_missing", param: "payout", message: `No such payout: '${payoutId}'` })
          if (!payout.automatic || payout.reconciliation_status !== "completed") {
            return stripeError(400, { type: "invalid_request_error", param: "payout", message: "Balance transaction history can only be filtered on automatic transfers, not manual." })
          }
        }
        return page(request, url, data.transactions, (t, params) => matches(params, "payout", t.payout) && matches(params, "type", t.type) && matches(params, "source", t.source))
      }),
      read("/v1/charges", "charge_read", (request, _params, url) => page(request, url, data.charges, (c, params) => matches(params, "payment_intent", c.payment_intent))),
      read("/v1/charges/:id", "charge_read", (_request, params) => retrieve(data.charges, params.id, "charge")),
      read("/v1/refunds", "charge_read", (request, _params, url) =>
        page(request, url, data.refunds, (r, params) => matches(params, "charge", r.charge) && matches(params, "payment_intent", r.payment_intent)),
      ),
      read("/v1/disputes", "dispute_read", (request, _params, url) =>
        page(request, url, data.disputes, (d, params) => matches(params, "charge", d.charge) && matches(params, "payment_intent", d.payment_intent)),
      ),
      read("/v1/disputes/:id", "dispute_read", (_request, params) => retrieve(data.disputes, params.id, "dispute")),
      {
        // Anything else under /v1: a write is refused for lack of its permission (the key has no writes), an unknown read is a 404
        method: "*",
        path: "/v1/*",
        handle: (request, ctx) => {
          const grants = authorize(request)
          if (grants instanceof Response) return grants
          if (request.method !== "GET") {
            const resource = ctx.params["*"].split("/")[0]
            const permission = { refunds: "charge_write", charges: "charge_write", payouts: "payout_write", disputes: "dispute_write", payment_intents: "payment_intent_write" }[resource] ?? `${resource}_write`
            return forbidden(permission)
          }
          return stripeError(404, { type: "invalid_request_error", message: `Unrecognized request URL (GET: /v1/${ctx.params["*"]}).` })
        },
      },
      {
        method: "POST",
        path: "/_fake/fault",
        handle: async (request) => {
          const body = (await request.json().catch(() => ({}))) as { status?: number; times?: number }
          fault = body.status ? { status: body.status, times: body.times ?? 1 } : null
          return Response.json({ ok: true, fault })
        },
      },
      {
        // { type, target, secret? }: moves a payout or dispute on, then signs its event with the webhook secret (STRIPE_WEBHOOK_SECRET by default) and posts it to target
        method: "POST",
        path: "/_fake/events",
        handle: async (request) => {
          const body = (await request.json().catch(() => ({}))) as { type?: string; target?: string; secret?: string; id?: string }
          const target = localTarget(body.target)
          if (!target) return Response.json({ fake: true, error: "target must be an http URL on this machine, e.g. http://localhost:3000/api/stripe/webhook" }, { status: 400 })
          const secret = body.secret ?? process.env.STRIPE_WEBHOOK_SECRET
          if (!secret) return Response.json({ fake: true, error: "No secret: pass one, or set STRIPE_WEBHOOK_SECRET for the fakes server" }, { status: 400 })
          const now = Math.floor(Date.now() / 1000)
          const object = applyEvent(data, body.type ?? "", body.id, now)
          if (!object) return Response.json({ fake: true, error: `Can't send "${body.type}": try payout.paid, payout.failed, charge.dispute.created or charge.dispute.closed` }, { status: 400 })
          const payload = JSON.stringify(event(body.type!, object, now))
          const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret })
          const response = await fetch(target, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: payload })
          return Response.json({ ok: response.ok, status: response.status, type: body.type, object: (object as { id: string }).id })
        },
      },
    ]
  },
}

/** Changes the fake's data the way the event says, and returns the object the event carries (null for a type it can't send) */
function applyEvent(data: StripeFixtures, type: string, id: string | undefined, now: number): FakePayout | FakeDispute | null {
  if (type === "payout.paid" || type === "payout.failed") {
    const payout = data.payouts.find((p) => p.id === (id ?? (type === "payout.paid" ? "po_fake_in_transit" : "po_fake_pending")))
    if (!payout) return null
    payout.status = type === "payout.paid" ? "paid" : "failed"
    if (type === "payout.failed") Object.assign(payout, { failure_code: "account_closed", failure_message: "The bank account has been closed.", reconciliation_status: "not_applicable" })
    else payout.reconciliation_status = "completed"
    return payout
  }
  if (type === "charge.dispute.created") {
    const charge = data.charges.find((c) => c.id === (id ?? "ch_fake_lsc_4"))
    if (!charge) return null
    charge.disputed = true
    const dispute: FakeDispute = {
      id: `du_fake${randomBytes(6).toString("hex")}`,
      object: "dispute",
      amount: charge.amount,
      currency: "usd",
      charge: charge.id,
      payment_intent: charge.payment_intent,
      created: now,
      reason: "duplicate",
      status: "needs_response",
      is_charge_refundable: false,
      balance_transactions: [],
      evidence: { customer_name: "Test Cardholder", customer_email_address: "cardholder@example.com" },
      evidence_details: { due_by: now + 7 * 86_400, has_evidence: false, past_due: false, submission_count: 0 },
      livemode: false,
    }
    data.disputes.push(dispute)
    return dispute
  }
  if (type === "charge.dispute.closed") {
    const dispute = data.disputes.find((d) => d.id === (id ?? "du_fake_open"))
    if (!dispute) return null
    dispute.status = "lost"
    return dispute
  }
  return null
}
