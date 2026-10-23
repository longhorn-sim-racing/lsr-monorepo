import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  stripeSnapshot: vi.fn(),
  withPayments: vi.fn(),
  prisma: {
    stripeBalanceDaily: { findFirst: vi.fn() },
    stripePayout: { findFirst: vi.fn(), findUnique: vi.fn() },
    stripeCharge: { findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
  },
}))
vi.mock("@/server/db", () => ({ prisma: mocks.prisma }))
vi.mock("@/server/connectors/stripe/connector", () => ({ stripeConnector: { status: mocks.status } }))
vi.mock("@/server/connectors/stripe/read", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/connectors/stripe/read")>()), stripeSnapshot: mocks.stripeSnapshot, withPayments: mocks.withPayments }))

import { stripeOverviewTool } from "./stripe-overview"

const now = Date.now()
const day = 86_400_000
const status = (state: string, lastSyncAt: string | null = new Date(now - 3_600_000).toISOString()) => ({ id: "stripe", label: "Stripe", state, lastSyncAt, missingEnv: state === "not_configured" ? ["STRIPE_READONLY_KEY"] : [], missingSettings: [] })
const run = (input: Record<string, unknown> = {}) => stripeOverviewTool.run(stripeOverviewTool.input.parse(input), { roomId: "r1", actor: { userId: "u1", displayName: "Gray" } })

const payout = (id: string, status: string, amountCents: number, arrivalDays: number, extra = {}) => ({ id, status, amountCents, currency: "usd", arrivalDate: new Date(Date.UTC(2026, 9, 22) + arrivalDays * day), createdAt: new Date(now - 2 * day), method: "standard", failureCode: null, syncedAt: new Date(), charges: 0, ...extra })

beforeEach(() => {
  mocks.status.mockResolvedValue(status("connected"))
  mocks.prisma.stripeCharge.aggregate.mockResolvedValue({ _count: 4, _sum: { amountCents: 6500, feeCents: 250, amountRefundedCents: 500 } })
  mocks.stripeSnapshot.mockResolvedValue({
    balance: { date: new Date("2026-10-22T00:00:00Z"), availableCents: 941, pendingCents: 1882, currency: "usd" },
    payouts: [payout("po_pending", "pending", 3854, 2), payout("po_transit", "in_transit", 941, 1), payout("po_paid", "paid", 2838, -6, { charges: 2 }), payout("po_failed", "failed", 1880, -28, { failureCode: "no_account" })],
    refunds: [{ id: "re_1", amountCents: 1000, status: "failed", createdAt: new Date(now - 5 * day), member: "Test Driver" }],
    disputes: [{ id: "du_1", amountCents: 1000, status: "warning_needs_response", reason: "fraudulent", createdAt: new Date(now - day), evidenceDueBy: new Date(now + 3 * day - 60_000), member: "Test Driver", item: "LSC entry" }],
    openDisputes: 1,
  })
})

describe("stripe_overview", () => {
  it("is deferred, read only and named for its service", () => {
    expect(stripeOverviewTool).toMatchObject({ name: "stripe_overview", deferred: true })
    expect(stripeOverviewTool.writes).toBeFalsy()
  })

  it("sums up the balance, payouts on their way, disputes due and the window's charges", async () => {
    const result = await run()
    const data = JSON.parse(result.forModel)
    expect(data.balance).toEqual({ asOf: "2026-10-22", availableDollars: 9.41, pendingDollars: 18.82 })
    expect(data.connection).toMatch(/^Stripe: connected, last synced/)
    expect(data.payouts.map((p: { status: string }) => p.status)).toEqual(["Pending", "On its way", "Paid", "Failed"])
    expect(data.payouts[3]).toMatchObject({ failureCode: "no_account" })
    expect(data.disputes[0]).toMatchObject({ status: "Inquiry: respond", daysLeft: 3, member: "Test Driver", stripe: "https://dashboard.stripe.com/disputes/du_1" })
    expect(data.chargesInWindow).toMatchObject({ succeeded: 4, grossDollars: 65, feeDollars: 2.5 })
    expect(data.readOnly).toMatch(/Stripe dashboard/)
    expect(result.displays?.[0]).toMatchObject({ kind: "stats", items: expect.arrayContaining([{ label: "Next payout", value: "$9.41", hint: "arrives 2026-10-23" }]) })
  })

  it("dates payout arrivals by their UTC day, not the Central day before", async () => {
    const data = JSON.parse((await run({ show: "payouts" })).forModel)
    expect(data.payouts[0].arrives).toBe("2026-10-24")
  })

  it("breaks one payout down by charge, with what each was for", async () => {
    mocks.prisma.stripePayout.findUnique.mockResolvedValue(payout("po_paid", "paid", 2838, -6))
    mocks.prisma.stripeCharge.findMany.mockResolvedValue([])
    mocks.withPayments.mockResolvedValue([
      { id: "ch_1", createdAt: new Date(now - 12 * day), amountCents: 1000, amountRefundedCents: 500, status: "succeeded", disputed: false, feeCents: 59, netCents: 941, purpose: null, payment: { member: "Test Driver", item: "LSC entry", status: "refunded" }, payout: null, dashboardUrl: "https://dashboard.stripe.com/payments/pi_1" },
      { id: "ch_2", createdAt: new Date(now - 11 * day), amountCents: 2500, amountRefundedCents: 0, status: "succeeded", disputed: false, feeCents: 103, netCents: 2397, purpose: "donation", payment: null, payout: null, dashboardUrl: null },
    ])
    const data = JSON.parse((await run({ payout: "po_paid" })).forModel)
    expect(data.breakdown).toMatchObject({ charges: 2, grossDollars: 35, feeDollars: 1.62, netDollars: 33.38, otherDollars: -5 })
    expect(data.charges[0].for).toEqual({ member: "Test Driver", item: "LSC entry", paymentStatus: "refunded" })
    expect(data.charges[1].for).toEqual({ purpose: "donation" })
  })

  it("says plainly when a payout id isn't synced", async () => {
    mocks.prisma.stripePayout.findUnique.mockResolvedValue(null)
    expect(await run({ payout: "po_nope" })).toMatchObject({ isError: true })
  })

  it("says it isn't connected when it's off and nothing was ever synced", async () => {
    mocks.status.mockResolvedValue(status("off", null))
    mocks.prisma.stripeBalanceDaily.findFirst.mockResolvedValue(null)
    mocks.prisma.stripePayout.findFirst.mockResolvedValue(null)
    const result = await run()
    expect(result.forModel).toMatch(/switched off on System → Connections; never synced\. There's no Stripe data to read/)
    expect(mocks.stripeSnapshot).not.toHaveBeenCalled()
  })

  it("still answers from synced data when switched off, saying how old it is", async () => {
    mocks.status.mockResolvedValue(status("off"))
    mocks.prisma.stripeBalanceDaily.findFirst.mockResolvedValue({ date: new Date() })
    const data = JSON.parse((await run()).forModel)
    expect(data.connection).toMatch(/Stripe is switched off .* last synced/)
    expect(data.balance).toBeTruthy()
  })

  it("refuses a payout id that isn't one", () => {
    expect(stripeOverviewTool.input.safeParse({ payout: "ch_123" }).success).toBe(false)
  })
})
