import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({
  saveBalance: vi.fn(),
  savePayout: vi.fn(),
  saveCharge: vi.fn(),
  saveRefund: vi.fn(),
  saveDispute: vi.fn(),
  applyChargeTransactions: vi.fn(),
}))
const db = vi.hoisted(() => ({ linked: [] as { payoutId: string }[] }))
vi.mock("./store", () => store)
vi.mock("@/server/db", () => ({ prisma: { stripeCharge: { findMany: vi.fn(async () => db.linked) } } }))

import { mountFakes } from "../fakes/testing"
import { stripeReadClient } from "./client"
import { STRIPE_FAKE_KEY, STRIPE_FAKE_KEY_NO_DISPUTES, stripeFake } from "./fake/handlers"
import { BACKFILL_DAYS, SYNC_LOOKBACK_DAYS, syncStripe } from "./sync"

beforeEach(() => {
  db.linked = []
  store.savePayout.mockResolvedValue(true)
  store.saveDispute.mockResolvedValue(true)
  store.applyChargeTransactions.mockResolvedValue(2)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("syncStripe against the fake", () => {
  it("stores the balance, payouts, charges, refunds and disputes, and breaks down paid automatic payouts", async () => {
    mountFakes([stripeFake])
    const result = await syncStripe(stripeReadClient(STRIPE_FAKE_KEY, { maxNetworkRetries: 0 }))

    expect(result.errors).toEqual([])
    expect(result.more).toBe(false)
    expect(store.saveBalance).toHaveBeenCalledOnce()
    expect(store.savePayout).toHaveBeenCalledTimes(6)
    expect(store.saveCharge).toHaveBeenCalledTimes(9)
    expect(store.saveRefund).toHaveBeenCalledTimes(2)
    expect(store.saveDispute).toHaveBeenCalledTimes(2)
    // Each write is stamped with when its data was asked for
    expect(store.savePayout.mock.calls[0][1]).toBeInstanceOf(Date)

    // Fees from every recent transaction, then the contents of the two paid automatic payouts (not the manual or failed one)
    const linkCalls = store.applyChargeTransactions.mock.calls.filter((call) => call[1])
    expect(linkCalls.map((call) => call[1]).sort()).toEqual(["po_fake_paid_1", "po_fake_paid_2"])
    expect(linkCalls.find((call) => call[1] === "po_fake_paid_1")?.[0].map((t: { id: string }) => t.id).sort()).toEqual(["txn_fake_lsc_1", "txn_fake_lsc_2", "txn_fake_po_paid_1"])
    expect(result.summary).toMatch(`Last ${SYNC_LOOKBACK_DAYS} days`)
  })

  it("doesn't list a payout's contents again once its charges are linked", async () => {
    const fakes = mountFakes([stripeFake])
    db.linked = [{ payoutId: "po_fake_paid_1" }, { payoutId: "po_fake_paid_2" }]
    await syncStripe(stripeReadClient(STRIPE_FAKE_KEY, { maxNetworkRetries: 0 }))
    expect(fakes.requests.some((r) => r.url.includes("payout="))).toBe(false)
  })

  it("looks back further on its first run", async () => {
    const fakes = mountFakes([stripeFake])
    const now = new Date("2026-10-22T12:00:00Z")
    const result = await syncStripe(stripeReadClient(STRIPE_FAKE_KEY, { maxNetworkRetries: 0 }), { backfill: true, now })
    const since = Math.floor((now.getTime() - BACKFILL_DAYS * 86_400_000) / 1000)
    expect(new URL(fakes.requests.find((r) => r.path === "/v1/payouts")!.url).searchParams.get("created[gte]")).toBe(String(since))
    expect(result.summary).toMatch(`First run, back ${BACKFILL_DAYS} days`)
  })

  it("carries on past a step that fails, and reports it", async () => {
    mountFakes([stripeFake])
    const result = await syncStripe(stripeReadClient(STRIPE_FAKE_KEY_NO_DISPUTES, { maxNetworkRetries: 0 }))
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/^disputes: Stripe 403/)
    expect(store.saveRefund).toHaveBeenCalledTimes(2)
    expect(store.saveDispute).not.toHaveBeenCalled()
  })

  it("stops at the deadline and says the next run continues", async () => {
    mountFakes([stripeFake])
    const controller = new AbortController()
    store.saveBalance.mockImplementation(async () => controller.abort(new DOMException("deadline", "TimeoutError")))
    const result = await syncStripe(stripeReadClient(STRIPE_FAKE_KEY, { maxNetworkRetries: 0, signal: controller.signal }), { signal: controller.signal })
    expect(result.more).toBe(true)
    expect(result.errors).toEqual([])
    expect(store.savePayout).not.toHaveBeenCalled()
    expect(result.summary).toMatch(/next run continues/)
  })
})
