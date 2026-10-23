import Stripe from "stripe"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fakesOrigin, serviceFetch } from "../base-url"
import { mountFakes } from "../fakes/testing"
import type { FakeService } from "../fakes/types"
import { modeProblem, readKeyProblem, STRIPE_TIMEOUT_MS, StripeReadError, stripeReadClient } from "./client"
import { fixtureBalance, stripeFixtures } from "./fake/fixtures"
import { STRIPE_FAKE_KEY, STRIPE_FAKE_KEY_EXPIRED, STRIPE_FAKE_KEY_NO_DISPUTES, stripeFake } from "./fake/handlers"

afterEach(() => {
  vi.unstubAllGlobals()
})

const DAY_MS = 86_400_000
const longAgo = () => new Date(Date.now() - 400 * DAY_MS)

/** The SDK pointed at the fakes, for checking the fake itself (writes, paging) the way Stripe would answer */
function rawSdk(key = STRIPE_FAKE_KEY) {
  const fakes = new URL(fakesOrigin())
  return new Stripe(key, { host: fakes.hostname, port: Number(fakes.port), protocol: "http", httpClient: Stripe.createFetchHttpClient(serviceFetch("stripe")), maxNetworkRetries: 0, telemetry: false })
}

describe("the Stripe read client against the fake", () => {
  it("reads the balance, payouts, charges, transactions, refunds and disputes with GETs only", async () => {
    const fakes = mountFakes([stripeFake])
    const client = stripeReadClient(STRIPE_FAKE_KEY, { maxNetworkRetries: 0 })
    const fixtures = stripeFixtures()
    const balance = await client.balance()
    expect(balance.available[0].amount).toBe(fixtureBalance(fixtures.transactions, fixtures.payouts).available)
    expect(balance.pending[0].amount).toBe(fixtureBalance(fixtures.transactions, fixtures.payouts).pending)

    const payouts = await client.payouts(longAgo())
    expect(payouts.map((p) => p.id)).toEqual(["po_fake_pending", "po_fake_in_transit", "po_fake_paid_2", "po_fake_paid_1", "po_fake_failed", "po_fake_manual"])
    expect((await client.charges(longAgo())).length).toBe(fixtures.charges.length)
    expect((await client.payoutTransactions("po_fake_paid_1")).every((t) => t.type === "payout" || t.source !== null)).toBe(true)
    expect((await client.refunds(longAgo())).map((r) => r.status).sort()).toEqual(["failed", "succeeded"])
    expect((await client.disputes(longAgo())).map((d) => d.id)).toEqual(["du_fake_open", "du_fake_won"])
    expect(await client.balanceTransactions(longAgo())).toHaveLength(fixtures.transactions.length)

    expect(fakes.requests.every((r) => r.method === "GET")).toBe(true)
    expect(fakes.requests[0].headers.get("authorization")).toBe(`Bearer ${STRIPE_FAKE_KEY}`)
  })

  it("filters by created date", async () => {
    mountFakes([stripeFake])
    const charges = await stripeReadClient(STRIPE_FAKE_KEY, { maxNetworkRetries: 0 }).charges(new Date(Date.now() - 7 * DAY_MS))
    expect(charges.map((c) => c.id).sort()).toEqual(["ch_fake_event_1", "ch_fake_lsc_4", "ch_fake_lsc_5", "ch_fake_lsc_6"])
  })

  it("refuses a secret key or a live key outside production before calling Stripe", () => {
    const fakes = mountFakes([stripeFake])
    expect(() => stripeReadClient("sk_" + "test_" + "x".repeat(24))).toThrow(/restricted key/)
    expect(() => stripeReadClient("rk_" + "live_" + "x".repeat(24))).toThrow(/only used in production/)
    expect(readKeyProblem("rk_" + "live_" + "x".repeat(24), { VERCEL_ENV: "production" })).toBeNull()
    expect(readKeyProblem(undefined)).toMatch(/isn't set/)
    expect(fakes.requests).toHaveLength(0)
  })

  it("says why a call failed, with the status and a hint, never the key", async () => {
    mountFakes([stripeFake])
    const expired = await stripeReadClient(STRIPE_FAKE_KEY_EXPIRED, { maxNetworkRetries: 0 })
      .balance()
      .catch((e: unknown) => e)
    expect(expired).toBeInstanceOf(StripeReadError)
    expect(expired).toMatchObject({ status: 401, type: "authentication_error" })
    expect(String((expired as Error).message)).toMatch(/expired or was rotated/)
    expect(String((expired as Error).message)).not.toContain(STRIPE_FAKE_KEY_EXPIRED)

    const forbidden = await stripeReadClient(STRIPE_FAKE_KEY_NO_DISPUTES, { maxNetworkRetries: 0 })
      .disputes(longAgo())
      .catch((e: unknown) => e)
    expect(forbidden).toMatchObject({ status: 403 })
    expect(String((forbidden as Error).message)).toMatch(/rak_dispute_read.*missing a Read permission/)
  })

  it("retries Stripe's 500s and gives up on a rate limit", async () => {
    const fakes = mountFakes([stripeFake])
    await fetch("http://127.0.0.1:3999/stripe/_fake/fault", { method: "POST", body: JSON.stringify({ status: 500, times: 1 }) })
    expect((await stripeReadClient(STRIPE_FAKE_KEY, { maxNetworkRetries: 1 }).balance()).object).toBe("balance")
    expect(fakes.requests.filter((r) => r.path === "/v1/balance")).toHaveLength(2)

    await fetch("http://127.0.0.1:3999/stripe/_fake/fault", { method: "POST", body: JSON.stringify({ status: 429, times: 5 }) })
    await expect(stripeReadClient(STRIPE_FAKE_KEY, { maxNetworkRetries: 0 }).balance()).rejects.toMatchObject({ status: 429 })
  })

  it("stops when the caller's signal aborts", async () => {
    const fakes = mountFakes([stripeFake])
    const reason = new DOMException("deadline", "TimeoutError")
    await expect(stripeReadClient(STRIPE_FAKE_KEY, { signal: AbortSignal.abort(reason) }).balance()).rejects.toBe(reason)
    expect(fakes.requests).toHaveLength(0)
  })

  it("keeps a 20 s timeout on every call (the SDK's own is 80 s)", async () => {
    mountFakes([stripeFake])
    const timers = vi.spyOn(globalThis, "setTimeout")
    await stripeReadClient(STRIPE_FAKE_KEY, { maxNetworkRetries: 0 }).balance()
    expect(timers.mock.calls.some(([, ms]) => ms === STRIPE_TIMEOUT_MS)).toBe(true)
  })
})

describe("the live-mode check", () => {
  it("refuses test data in production and live data elsewhere", () => {
    expect(modeProblem([{ livemode: false }], { VERCEL_ENV: "production" })).toMatch(/test-mode data in production/)
    expect(modeProblem([{ livemode: true }], {})).toMatch(/live-mode data outside production/)
    expect(modeProblem([{ livemode: false }, { id: "re_1" }], {})).toBeNull()
    expect(modeProblem([{ livemode: true }], { VERCEL_ENV: "production" })).toBeNull()
  })
})

describe("the Stripe fake", () => {
  it("pages lists like Stripe, newest first, and the SDK's auto-paging walks them", async () => {
    const fakes = mountFakes([stripeFake])
    const stripe = rawSdk()
    const first = await stripe.charges.list({ limit: 2 })
    expect(first).toMatchObject({ object: "list", has_more: true })
    expect(first.data.map((c) => c.created)).toEqual([...first.data.map((c) => c.created)].sort((a, b) => b - a))
    const all = await stripe.charges.list({ limit: 2 }).autoPagingToArray({ limit: 100 })
    expect(all).toHaveLength(stripeFixtures().charges.length)
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length)
    expect(fakes.requests.some((r) => r.url.includes("starting_after="))).toBe(true)
    await expect(stripe.charges.list({ limit: 101 })).rejects.toMatchObject({ statusCode: 400, param: "limit" })
    await expect(stripe.payouts.retrieve("po_nope")).rejects.toMatchObject({ statusCode: 404, code: "resource_missing" })
  })

  it("refuses every write, naming the permission it would need", async () => {
    mountFakes([stripeFake])
    const stripe = rawSdk()
    await expect(stripe.refunds.create({ charge: "ch_fake_lsc_1" })).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("rak_charge_write") })
    await expect(stripe.payouts.create({ amount: 100, currency: "usd" })).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("rak_payout_write") })
  })

  it("keeps each paid payout's transactions adding up to its amount", () => {
    const { payouts, transactions } = stripeFixtures()
    for (const payout of payouts.filter((p) => p.automatic && p.reconciliation_status === "completed")) {
      const inside = transactions.filter((t) => t.payout === payout.id)
      expect(inside.filter((t) => t.type !== "payout").reduce((n, t) => n + t.net, 0), payout.id).toBe(payout.amount)
      expect(inside.find((t) => t.type === "payout")?.amount, payout.id).toBe(-payout.amount)
    }
  })

  it("refuses to list a manual payout's transactions", async () => {
    mountFakes([stripeFake])
    await expect(rawSdk().balanceTransactions.list({ payout: "po_fake_manual" })).rejects.toMatchObject({ statusCode: 400 })
  })

  it("signs a payout event and posts it to a local webhook URL", async () => {
    const received: { signature: string | null; body: string }[] = []
    const app: FakeService = {
      id: "app",
      create: () => [
        {
          method: "POST",
          path: "/api/stripe/webhook",
          handle: async (request) => {
            received.push({ signature: request.headers.get("stripe-signature"), body: await request.text() })
            return Response.json({ received: true })
          },
        },
      ],
    }
    mountFakes([stripeFake, app])
    const secret = "whsec_" + "fake".repeat(8)
    const answer = await fetch("http://127.0.0.1:3999/stripe/_fake/events", { method: "POST", body: JSON.stringify({ type: "payout.paid", target: "http://127.0.0.1:3999/app/api/stripe/webhook", secret }) })
    expect(await answer.json()).toMatchObject({ ok: true, object: "po_fake_in_transit" })
    const event = Stripe.webhooks.constructEvent(received[0].body, received[0].signature!, secret)
    expect(event).toMatchObject({ type: "payout.paid", data: { object: { id: "po_fake_in_transit", status: "paid" } } })
    // The fake's own data moved on too, so a sync after it sees the payout paid
    const payout = await rawSdk().payouts.retrieve("po_fake_in_transit")
    expect(payout.status).toBe("paid")

    const refused = await fetch("http://127.0.0.1:3999/stripe/_fake/events", { method: "POST", body: JSON.stringify({ type: "payout.paid", target: "https://example.com/hook", secret }) })
    expect(refused.status).toBe(400)
  })
})
