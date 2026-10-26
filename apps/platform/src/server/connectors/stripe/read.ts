import type { StripeCharge, StripeDispute, StripePayout, StripeRefund } from "@prisma/client"
import { stripeDashboardUrl } from "@/lib/payments"
import { prisma } from "@/server/db"
import { itemName } from "@/server/jack/tools/payments-summary"

/**
 * Reads the synced Stripe tables (design §12.3) for the Stripe panel on Payments and Jack's
 * stripe_overview. Charges are joined to the app's Payment rows through the PaymentIntent id
 * (Payment.providerRef), which is how the webhook already finds a payment; donations come through the
 * donation link and have no Payment row.
 */

/** Dispute statuses that still need something from the club, or are still being decided */
export const OPEN_DISPUTE_STATUSES = ["warning_needs_response", "needs_response", "warning_under_review", "under_review"]
/** Dispute statuses where the club has to respond before the due date */
export const RESPOND_STATUSES = ["warning_needs_response", "needs_response"]
/** Payouts on their way */
export const UPCOMING_PAYOUT_STATUSES = ["pending", "in_transit"]

const DAY_MS = 86_400_000

export type ChargeWithPayment = StripeCharge & {
  payment: { id: string; userId: string; member: string; item: string; status: string } | null
  payout: Pick<StripePayout, "id" | "status" | "arrivalDate"> | null
  dashboardUrl: string | null
}

/** Charges with the app's payment each one was for (when there is one) and the payout it went out in */
export async function withPayments(charges: StripeCharge[]): Promise<ChargeWithPayment[]> {
  const intents = [...new Set(charges.map((c) => c.paymentIntentId).filter((id): id is string => Boolean(id)))]
  const payoutIds = [...new Set(charges.map((c) => c.payoutId).filter((id): id is string => Boolean(id)))]
  const [payments, payouts] = await Promise.all([
    intents.length
      ? prisma.payment.findMany({
          where: { providerRef: { in: intents } },
          select: {
            id: true,
            userId: true,
            status: true,
            providerRef: true,
            metadata: true,
            product: { select: { name: true, type: true } },
            eventRegistration: { select: { event: { select: { title: true } } } },
            user: { select: { displayName: true } },
          },
        })
      : [],
    payoutIds.length ? prisma.stripePayout.findMany({ where: { id: { in: payoutIds } }, select: { id: true, status: true, arrivalDate: true } }) : [],
  ])
  const paymentByIntent = new Map(payments.map((p) => [p.providerRef, p]))
  const payoutById = new Map(payouts.map((p) => [p.id, p]))
  return charges.map((charge) => {
    const payment = charge.paymentIntentId ? paymentByIntent.get(charge.paymentIntentId) : undefined
    return {
      ...charge,
      payment: payment ? { id: payment.id, userId: payment.userId, member: payment.user.displayName, item: itemName(payment), status: payment.status } : null,
      payout: charge.payoutId ? (payoutById.get(charge.payoutId) ?? null) : null,
      dashboardUrl: stripeDashboardUrl(charge.paymentIntentId),
    }
  })
}

export type StripeSnapshot = {
  balance: { date: Date; availableCents: number; pendingCents: number; currency: string } | null
  payouts: (StripePayout & { charges: number })[]
  refunds: (StripeRefund & { member: string | null })[]
  disputes: (StripeDispute & { member: string | null; item: string | null })[]
  /** Disputes still open, most urgent first; a subset of `disputes` */
  openDisputes: number
}

/** Who a refund or dispute is about, through its PaymentIntent */
async function membersByIntent(intents: (string | null)[]) {
  const ids = [...new Set(intents.filter((id): id is string => Boolean(id)))]
  if (!ids.length) return new Map<string, { member: string; item: string }>()
  const payments = await prisma.payment.findMany({
    where: { providerRef: { in: ids } },
    select: { providerRef: true, metadata: true, product: { select: { name: true, type: true } }, eventRegistration: { select: { event: { select: { title: true } } } }, user: { select: { displayName: true } } },
  })
  return new Map(payments.map((p) => [p.providerRef!, { member: p.user.displayName, item: itemName(p) }]))
}

/**
 * The latest balance, recent payouts (with how many charges each paid out), refunds and disputes. Open
 * disputes come first however old they are; the rest is the last `days` days
 */
export async function stripeSnapshot(options: { days?: number; limit?: number; now?: Date } = {}): Promise<StripeSnapshot> {
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - (options.days ?? 60) * DAY_MS)
  const limit = options.limit ?? 8
  const [balance, payouts, refunds, open, closed] = await Promise.all([
    prisma.stripeBalanceDaily.findFirst({ orderBy: { date: "desc" } }),
    prisma.stripePayout.findMany({ where: { OR: [{ createdAt: { gte: since } }, { status: { in: UPCOMING_PAYOUT_STATUSES } }] }, orderBy: [{ arrivalDate: "desc" }, { id: "desc" }], take: limit }),
    prisma.stripeRefund.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: limit }),
    prisma.stripeDispute.findMany({ where: { status: { in: OPEN_DISPUTE_STATUSES } }, orderBy: [{ evidenceDueBy: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }], take: limit }),
    prisma.stripeDispute.findMany({ where: { status: { notIn: OPEN_DISPUTE_STATUSES }, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: limit }),
  ])
  const linked = payouts.length ? await prisma.stripeCharge.groupBy({ by: ["payoutId"], where: { payoutId: { in: payouts.map((p) => p.id) } }, _count: { _all: true } }) : []
  const chargesByPayout = new Map(linked.map((row) => [row.payoutId, row._count._all]))
  const disputes = [...open, ...closed].slice(0, Math.max(limit, open.length))
  const members = await membersByIntent([...refunds.map((r) => r.paymentIntentId), ...disputes.map((d) => d.paymentIntentId)])
  return {
    balance,
    payouts: payouts.map((p) => ({ ...p, charges: chargesByPayout.get(p.id) ?? 0 })),
    refunds: refunds.map((r) => ({ ...r, member: (r.paymentIntentId && members.get(r.paymentIntentId)?.member) || null })),
    disputes: disputes.map((d) => ({ ...d, member: (d.paymentIntentId && members.get(d.paymentIntentId)?.member) || null, item: (d.paymentIntentId && members.get(d.paymentIntentId)?.item) || null })),
    openDisputes: open.length,
  }
}

/** Disputes open on these PaymentIntents, for the payments list's badges */
export async function openDisputesFor(intents: (string | null)[]): Promise<Map<string, Pick<StripeDispute, "id" | "status" | "evidenceDueBy">>> {
  const ids = [...new Set(intents.filter((id): id is string => Boolean(id?.startsWith("pi_"))))]
  if (!ids.length) return new Map()
  const rows = await prisma.stripeDispute.findMany({ where: { paymentIntentId: { in: ids }, status: { in: OPEN_DISPUTE_STATUSES } }, select: { id: true, status: true, evidenceDueBy: true, paymentIntentId: true } })
  return new Map(rows.map((row) => [row.paymentIntentId!, { id: row.id, status: row.status, evidenceDueBy: row.evidenceDueBy }]))
}

/** Plain words for a dispute's status */
export const DISPUTE_STATUS_LABEL: Record<string, string> = {
  warning_needs_response: "Inquiry: respond",
  needs_response: "Needs a response",
  warning_under_review: "Inquiry under review",
  under_review: "Under review",
  warning_closed: "Inquiry closed",
  won: "Won",
  lost: "Lost",
  prevented: "Prevented",
}

/** Plain words for a payout's status */
export const PAYOUT_STATUS_LABEL: Record<string, string> = { pending: "Pending", in_transit: "On its way", paid: "Paid", failed: "Failed", canceled: "Canceled" }
