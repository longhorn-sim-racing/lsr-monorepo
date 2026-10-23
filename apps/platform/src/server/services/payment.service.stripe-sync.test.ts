import Stripe from "stripe"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The webhook's payout.* and charge.dispute.* cases (Jack 2.0 sources-a): they only update the synced Stripe tables
const store = vi.hoisted(() => ({ savePayout: vi.fn(), saveDispute: vi.fn() }))
const prisma = vi.hoisted(() => ({ payment: { findUnique: vi.fn(), updateMany: vi.fn() }, $transaction: vi.fn() }))
vi.mock("@/server/connectors/stripe/store", () => store)
vi.mock("@/server/db", () => ({ prisma }))
vi.mock("@/server/audit/log", () => ({ createAuditLog: vi.fn() }))
vi.mock("@/server/services/notification.service", () => ({ sendNotification: vi.fn() }))

import { stripeFixtures } from "@/server/connectors/stripe/fake/fixtures"
import { handleStripeWebhook } from "./payment.service"

const SECRET = "whsec_" + "test".repeat(8)
const fixtures = stripeFixtures()

/** An event signed the way Stripe signs it (Stripe's own test helper) */
function signed(type: string, object: unknown, created = 1_761_000_000) {
  const payload = JSON.stringify({ id: `evt_test_${type}`, object: "event", api_version: "2026-02-25.clover", created, type, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object } })
  return { body: Buffer.from(payload), signature: Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) }
}

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET)
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_" + "test_" + "x".repeat(24))
  store.savePayout.mockResolvedValue(true)
  store.saveDispute.mockResolvedValue(true)
})

describe("handleStripeWebhook: payouts and disputes", () => {
  it.each(["payout.created", "payout.updated", "payout.paid", "payout.failed", "payout.canceled", "payout.reconciliation_completed"])("saves the payout from %s, stamped with the event's time", async (type) => {
    const { body, signature } = signed(type, fixtures.payouts[0], 1_761_000_123)
    await handleStripeWebhook(body, signature)
    expect(store.savePayout).toHaveBeenCalledWith(expect.objectContaining({ id: "po_fake_pending" }), new Date(1_761_000_123_000))
    expect(store.saveDispute).not.toHaveBeenCalled()
  })

  it.each(["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated"])("saves the dispute from %s", async (type) => {
    const { body, signature } = signed(type, fixtures.disputes[0])
    await handleStripeWebhook(body, signature)
    expect(store.saveDispute).toHaveBeenCalledWith(expect.objectContaining({ id: "du_fake_open" }), expect.any(Date))
    expect(prisma.payment.findUnique).not.toHaveBeenCalled()
  })

  it("leaves the checkout and refund events as they were (they never touch the Stripe tables)", async () => {
    prisma.payment.findUnique.mockResolvedValue(null)
    const { body, signature } = signed("checkout.session.completed", { id: "cs_test_1", object: "checkout.session", payment_status: "paid", metadata: { paymentId: "nope" } })
    await handleStripeWebhook(body, signature)
    expect(prisma.payment.findUnique).toHaveBeenCalledWith({ where: { id: "nope" } })
    expect(store.savePayout).not.toHaveBeenCalled()
    expect(store.saveDispute).not.toHaveBeenCalled()
  })

  it("refuses an event with a bad signature before saving anything", async () => {
    const { body } = signed("payout.paid", fixtures.payouts[0])
    const forged = Stripe.webhooks.generateTestHeaderString({ payload: body.toString(), secret: "whsec_" + "nope".repeat(8) })
    await expect(handleStripeWebhook(body, forged)).rejects.toThrow(/signature/i)
    expect(store.savePayout).not.toHaveBeenCalled()
  })

  it("refuses a replayed event older than Stripe's 5-minute window", async () => {
    const payload = signed("payout.paid", fixtures.payouts[0]).body.toString()
    const old = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) - 600 })
    await expect(handleStripeWebhook(Buffer.from(payload), old)).rejects.toThrow(/tolerance|timestamp/i)
    expect(store.savePayout).not.toHaveBeenCalled()
  })
})
