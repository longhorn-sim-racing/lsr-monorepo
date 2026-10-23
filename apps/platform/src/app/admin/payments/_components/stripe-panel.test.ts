import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ status: vi.fn(), stripeSnapshot: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/connectors/stripe/connector", () => ({ stripeConnector: { status: mocks.status } }))
vi.mock("@/server/connectors/stripe/read", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/connectors/stripe/read")>()), stripeSnapshot: mocks.stripeSnapshot }))

import { StripePanel } from "./stripe-panel"

const now = Date.now()
const day = 86_400_000
const emptySnapshot = { balance: null, payouts: [], refunds: [], disputes: [], openDisputes: 0 }

beforeEach(() => {
  mocks.status.mockResolvedValue({ state: "connected", lastSyncAt: new Date(now - 3_600_000).toISOString() })
})

describe("the Stripe panel on Payments", () => {
  it("shows the balance, the next payout, and a loud notice for a dispute that needs a response", async () => {
    mocks.stripeSnapshot.mockResolvedValue({
      balance: { date: new Date("2026-10-22T00:00:00Z"), availableCents: 941, pendingCents: 1882, currency: "usd" },
      payouts: [
        { id: "po_1", status: "in_transit", amountCents: 941, arrivalDate: new Date("2026-10-23T00:00:00Z"), failureCode: null, charges: 0 },
        { id: "po_2", status: "failed", amountCents: 1880, arrivalDate: new Date("2026-09-24T00:00:00Z"), failureCode: "no_account", charges: 0 },
      ],
      refunds: [{ id: "re_1", amountCents: 1000, status: "failed", createdAt: new Date(now - 5 * day), member: "Test Driver" }],
      disputes: [{ id: "du_1", amountCents: 1000, status: "needs_response", reason: "fraudulent", createdAt: new Date(now - day), evidenceDueBy: new Date(now + 3 * day), member: "Test Driver", item: "LSC entry" }],
      openDisputes: 1,
    })
    const html = renderToStaticMarkup(await StripePanel())
    expect(html).toContain("$9.41")
    expect(html).toContain("$18.82 pending")
    // The payout lands on Oct 23 (a UTC date), not the 22nd in Central time
    expect(html).toContain("On its way, arrives Oct 23")
    expect(html).toContain("no account")
    expect(html).toMatch(/A \$10\.00 dispute needs a response by/)
    expect(html).toContain("https://dashboard.stripe.com/disputes/du_1")
  })

  it("says Stripe isn't connected when there's nothing synced and no key", async () => {
    mocks.status.mockResolvedValue({ state: "not_configured", lastSyncAt: null })
    mocks.stripeSnapshot.mockResolvedValue(emptySnapshot)
    const html = renderToStaticMarkup(await StripePanel())
    expect(html).toContain("Stripe isn&#x27;t connected yet")
    expect(html).toContain('href="/admin/connections"')
  })

  it("says the sync is switched off when it is", async () => {
    mocks.status.mockResolvedValue({ state: "off", lastSyncAt: null })
    mocks.stripeSnapshot.mockResolvedValue(emptySnapshot)
    expect(renderToStaticMarkup(await StripePanel())).toContain("switched off")
  })
})
