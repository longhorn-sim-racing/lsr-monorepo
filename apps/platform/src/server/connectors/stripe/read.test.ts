import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = vi.hoisted(() => ({
  payment: { findMany: vi.fn() },
  stripePayout: { findMany: vi.fn() },
  stripeBalanceDaily: { findFirst: vi.fn() },
  stripeRefund: { findMany: vi.fn() },
  stripeDispute: { findMany: vi.fn() },
  stripeCharge: { groupBy: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma }))

import { openDisputesFor, OPEN_DISPUTE_STATUSES, stripeSnapshot, withPayments } from "./read"

const charge = (id: string, paymentIntentId: string | null, extra = {}) => ({
  id,
  paymentIntentId,
  amountCents: 1000,
  amountRefundedCents: 0,
  currency: "usd",
  status: "succeeded",
  disputed: false,
  purpose: null,
  feeCents: 59,
  netCents: 941,
  payoutId: null,
  createdAt: new Date("2026-10-10T18:00:00Z"),
  syncedAt: new Date(),
  ...extra,
})

beforeEach(() => {
  prisma.payment.findMany.mockResolvedValue([
    { id: "p1", userId: "u1", status: "succeeded", providerRef: "pi_1", product: { name: "Lone Star Cup entry", type: "LEAGUE_FEE" }, eventRegistration: null, user: { displayName: "Test Driver" } },
  ])
  prisma.stripePayout.findMany.mockResolvedValue([{ id: "po_1", status: "paid", arrivalDate: new Date("2026-10-15T00:00:00Z") }])
})

describe("withPayments", () => {
  it("joins each charge to the site's payment through its PaymentIntent, and to its payout", async () => {
    const [joined, donation] = await withPayments([charge("ch_1", "pi_1", { payoutId: "po_1" }), charge("ch_2", "pi_2", { purpose: "donation" })])
    expect(prisma.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { providerRef: { in: ["pi_1", "pi_2"] } } }))
    expect(joined).toMatchObject({ payment: { id: "p1", member: "Test Driver", item: "Lone Star Cup entry" }, payout: { id: "po_1", status: "paid" }, dashboardUrl: "https://dashboard.stripe.com/payments/pi_1" })
    expect(donation).toMatchObject({ payment: null, payout: null, purpose: "donation" })
  })

  it("asks for nothing when there's nothing to join", async () => {
    expect(await withPayments([charge("ch_3", null)])).toEqual([expect.objectContaining({ payment: null, dashboardUrl: null })])
    expect(prisma.payment.findMany).not.toHaveBeenCalled()
  })
})

describe("stripeSnapshot", () => {
  it("lists open disputes first whatever their age, then recent closed ones, each with who it's about", async () => {
    prisma.stripeBalanceDaily.findFirst.mockResolvedValue(null)
    prisma.stripePayout.findMany.mockResolvedValue([{ id: "po_1", status: "in_transit", amountCents: 941, arrivalDate: new Date(), createdAt: new Date() }])
    prisma.stripeRefund.findMany.mockResolvedValue([])
    prisma.stripeDispute.findMany.mockImplementation(async ({ where }: { where: { status: { in?: string[] } } }) =>
      where.status.in ? [{ id: "du_open", paymentIntentId: "pi_1", status: "needs_response" }] : [{ id: "du_won", paymentIntentId: null, status: "won" }],
    )
    prisma.stripeCharge.groupBy.mockResolvedValue([{ payoutId: "po_1", _count: { _all: 3 } }])
    const snapshot = await stripeSnapshot({ days: 30 })
    expect(snapshot.disputes.map((d) => d.id)).toEqual(["du_open", "du_won"])
    expect(snapshot.disputes[0]).toMatchObject({ member: "Test Driver", item: "Lone Star Cup entry" })
    expect(snapshot.openDisputes).toBe(1)
    expect(snapshot.payouts[0].charges).toBe(3)
    // Payouts on their way always show
    expect(prisma.stripePayout.findMany.mock.calls[0][0].where.OR).toContainEqual({ status: { in: ["pending", "in_transit"] } })
  })
})

describe("openDisputesFor", () => {
  it("finds open disputes for the payments on a page, only by PaymentIntent", async () => {
    prisma.stripeDispute.findMany.mockResolvedValue([{ id: "du_1", status: "needs_response", evidenceDueBy: null, paymentIntentId: "pi_1" }])
    const found = await openDisputesFor(["pi_1", "cs_123", null])
    expect(prisma.stripeDispute.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { paymentIntentId: { in: ["pi_1"] }, status: { in: OPEN_DISPUTE_STATUSES } } }))
    expect(found.get("pi_1")).toMatchObject({ id: "du_1" })
    expect(await openDisputesFor(["cs_1"])).toEqual(new Map())
  })
})
