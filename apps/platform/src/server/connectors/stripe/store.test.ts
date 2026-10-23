import { Prisma } from "@prisma/client"
import type Stripe from "stripe"
import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = vi.hoisted(() => ({
  stripePayout: { updateMany: vi.fn(), create: vi.fn() },
  stripeDispute: { updateMany: vi.fn(), create: vi.fn() },
  stripeCharge: { updateMany: vi.fn(), upsert: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma }))

import { stripeFixtures } from "./fake/fixtures"
import { applyChargeTransactions, balanceRow, chargeRow, disputeRow, payoutRow, refundRow, saveDispute, savePayout } from "./store"

const fixtures = stripeFixtures(1_761_134_400) // 2025-10-22 12:00 UTC
const at = new Date("2026-10-22T10:00:00Z")
const asStripe = <T>(value: unknown) => value as T

beforeEach(() => {
  prisma.stripePayout.updateMany.mockResolvedValue({ count: 0 })
  prisma.stripePayout.create.mockResolvedValue({})
  prisma.stripeDispute.updateMany.mockResolvedValue({ count: 1 })
  prisma.stripeCharge.updateMany.mockResolvedValue({ count: 1 })
})

describe("Stripe rows", () => {
  it("keep a payout's amount, status, dates and failure, nothing else", () => {
    const failed = fixtures.payouts.find((p) => p.id === "po_fake_failed")!
    expect(payoutRow(asStripe<Stripe.Payout>(failed), at)).toEqual({
      id: "po_fake_failed",
      amountCents: 1880,
      currency: "usd",
      status: "failed",
      arrivalDate: new Date(failed.arrival_date * 1000),
      createdAt: new Date(failed.created * 1000),
      method: "standard",
      failureCode: "no_account",
      syncedAt: at,
    })
  })

  it("keep a charge without its card, billing or customer details", () => {
    const donation = fixtures.charges.find((c) => c.id === "ch_fake_donation")!
    const row = chargeRow(asStripe<Stripe.Charge>(donation), at)
    expect(row).toMatchObject({ id: "ch_fake_donation", paymentIntentId: "pi_fake_donation", amountCents: 2500, purpose: "donation", disputed: false })
    const text = JSON.stringify(row)
    for (const leak of ["example.com", "Test Donor", "4242", "visa"]) expect(text).not.toContain(leak)
  })

  it("keep a dispute's due date but never its evidence", () => {
    const open = fixtures.disputes.find((d) => d.id === "du_fake_open")!
    const row = disputeRow(asStripe<Stripe.Dispute>(open), at)
    expect(row).toMatchObject({ chargeId: "ch_fake_lsc_5", paymentIntentId: "pi_fake_lsc_5", status: "warning_needs_response", evidenceDueBy: new Date(open.evidence_details.due_by! * 1000) })
    expect(JSON.stringify(row)).not.toMatch(/cardholder|Test Cardholder/)
  })

  it("keep refunds, expanded ids included", () => {
    const refund = { ...fixtures.refunds[1], charge: { id: "ch_fake_lsc_6" } }
    expect(refundRow(asStripe<Stripe.Refund>(refund), at)).toMatchObject({ id: "re_fake_failed", chargeId: "ch_fake_lsc_6", status: "failed", amountCents: 1000 })
  })

  it("add up the USD balance on the club's (Chicago) day", () => {
    const balance = asStripe<Stripe.Balance>({ available: [{ amount: 500, currency: "usd" }, { amount: 99, currency: "eur" }], pending: [{ amount: -20, currency: "usd" }] })
    // 2 AM UTC on the 23rd is still the 22nd in Chicago
    expect(balanceRow(balance, new Date("2026-10-23T02:00:00Z"))).toEqual({ date: new Date("2026-10-22T00:00:00Z"), availableCents: 500, pendingCents: -20, currency: "usd" })
  })
})

describe("saving payouts and disputes from two sources", () => {
  const payout = asStripe<Stripe.Payout>(fixtures.payouts[0])

  it("updates only when the stored copy isn't newer, else creates", async () => {
    expect(await savePayout(payout, at)).toBe(true)
    expect(prisma.stripePayout.updateMany).toHaveBeenCalledWith({ where: { id: payout.id, syncedAt: { lte: at } }, data: expect.objectContaining({ syncedAt: at }) })
    expect(prisma.stripePayout.create).toHaveBeenCalledOnce()
  })

  it("leaves a newer row alone: the create collides and the conditional update still misses", async () => {
    prisma.stripePayout.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6" }))
    expect(await savePayout(payout, at)).toBe(false)
    expect(prisma.stripePayout.updateMany).toHaveBeenCalledTimes(2)
  })

  it("passes on other database errors", async () => {
    prisma.stripePayout.create.mockRejectedValue(new Error("connection lost"))
    await expect(savePayout(payout, at)).rejects.toThrow("connection lost")
  })

  it("marks a disputed charge", async () => {
    await saveDispute(asStripe<Stripe.Dispute>(fixtures.disputes[0]), at)
    expect(prisma.stripeCharge.updateMany).toHaveBeenCalledWith({ where: { id: "ch_fake_lsc_5" }, data: { disputed: true } })
  })
})

describe("applyChargeTransactions", () => {
  it("sets each charge's fee and net, and its payout, skipping refunds and the payout itself", async () => {
    const inPayout = fixtures.transactions.filter((t) => t.payout === "po_fake_paid_2")
    const updated = await applyChargeTransactions(asStripe<Stripe.BalanceTransaction[]>(inPayout), "po_fake_paid_2")
    expect(updated).toBe(2)
    expect(prisma.stripeCharge.updateMany.mock.calls.map((call) => call[0])).toEqual([
      { where: { id: "ch_fake_lsc_3" }, data: { feeCents: 59, netCents: 941, payoutId: "po_fake_paid_2" } },
      { where: { id: "ch_fake_donation" }, data: { feeCents: 103, netCents: 2397, payoutId: "po_fake_paid_2" } },
    ])
  })
})
