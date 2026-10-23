import { Prisma } from "@prisma/client"
import type Stripe from "stripe"
import { chicagoDay } from "@/lib/dates"
import { prisma } from "@/server/db"

/**
 * Writes Stripe's objects into the club's tables (design §12.3): the daily sync and the webhook
 * (payout.* and charge.dispute.* events on /api/stripe/webhook) both come through here. Only the
 * fields the console and Jack use are kept: never card details, billing names or emails, or a
 * dispute's evidence (customer PII).
 *
 * Payouts and disputes can arrive from both, in any order, so each write carries the time its data is
 * from (the event's `created`, or when the sync asked Stripe) and never replaces a row with older data.
 */

type Ref = string | { id: string } | null | undefined

/** An expandable field's id */
export const idOf = (ref: Ref): string | null => (typeof ref === "string" ? ref : (ref?.id ?? null))

const fromUnix = (seconds: number) => new Date(seconds * 1000)

export function payoutRow(p: Stripe.Payout, syncedAt: Date) {
  return {
    id: p.id,
    amountCents: p.amount,
    currency: p.currency,
    status: p.status,
    arrivalDate: fromUnix(p.arrival_date),
    createdAt: fromUnix(p.created),
    method: p.method ?? null,
    failureCode: p.failure_code ?? null,
    syncedAt,
  }
}

export function disputeRow(d: Stripe.Dispute, syncedAt: Date) {
  return {
    id: d.id,
    chargeId: idOf(d.charge) ?? "",
    paymentIntentId: idOf(d.payment_intent),
    amountCents: d.amount,
    status: d.status,
    reason: d.reason,
    evidenceDueBy: d.evidence_details?.due_by ? fromUnix(d.evidence_details.due_by) : null,
    createdAt: fromUnix(d.created),
    syncedAt,
  }
}

export function refundRow(r: Stripe.Refund, syncedAt: Date) {
  return {
    id: r.id,
    chargeId: idOf(r.charge) ?? "",
    paymentIntentId: idOf(r.payment_intent),
    amountCents: r.amount,
    status: r.status ?? "unknown",
    createdAt: fromUnix(r.created),
    syncedAt,
  }
}

/** A charge without its card, billing or customer details; `purpose` is metadata.purpose ("donation" for the donation link) */
export function chargeRow(c: Stripe.Charge, syncedAt: Date) {
  const purpose = c.metadata?.purpose
  return {
    id: c.id,
    paymentIntentId: idOf(c.payment_intent),
    amountCents: c.amount,
    amountRefundedCents: c.amount_refunded ?? 0,
    currency: c.currency,
    status: c.status,
    disputed: Boolean(c.disputed),
    purpose: typeof purpose === "string" && purpose.trim() ? purpose.trim().slice(0, 60) : null,
    createdAt: fromUnix(c.created),
    syncedAt,
  }
}

/** The day's balance in USD: what can be paid out, and what hasn't settled yet */
export function balanceRow(balance: Stripe.Balance, now: Date) {
  const usd = (entries: Stripe.Balance.Available[] | Stripe.Balance.Pending[]) => entries.filter((e) => e.currency === "usd").reduce((sum, e) => sum + e.amount, 0)
  return { date: chicagoDay(now), availableCents: usd(balance.available), pendingCents: usd(balance.pending), currency: "usd" }
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"

/**
 * Updates the row unless the stored one is from later (`update` is conditional on syncedAt and returns
 * how many rows it changed), or creates it. Returns whether it wrote. When two writers create the same
 * row at once, the loser retries as an update.
 */
async function saveNewest(write: { update(): Promise<number>; create(): Promise<unknown> }): Promise<boolean> {
  if (await write.update()) return true
  try {
    await write.create()
    return true
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return (await write.update()) > 0
  }
}

/** Saves a payout as of `at` (when its data is from); an older copy never replaces a newer one */
export function savePayout(payout: Stripe.Payout, at: Date): Promise<boolean> {
  const row = payoutRow(payout, at)
  return saveNewest({
    update: async () => (await prisma.stripePayout.updateMany({ where: { id: row.id, syncedAt: { lte: at } }, data: row })).count,
    create: () => prisma.stripePayout.create({ data: row }),
  })
}

/** Saves a dispute as of `at`, and marks its charge disputed */
export async function saveDispute(dispute: Stripe.Dispute, at: Date): Promise<boolean> {
  const row = disputeRow(dispute, at)
  const wrote = await saveNewest({
    update: async () => (await prisma.stripeDispute.updateMany({ where: { id: row.id, syncedAt: { lte: at } }, data: row })).count,
    create: () => prisma.stripeDispute.create({ data: row }),
  })
  if (wrote && row.chargeId) await prisma.stripeCharge.updateMany({ where: { id: row.chargeId }, data: { disputed: true } })
  return wrote
}

export async function saveRefund(refund: Stripe.Refund, at: Date): Promise<void> {
  const row = refundRow(refund, at)
  await prisma.stripeRefund.upsert({ where: { id: row.id }, create: row, update: row })
}

/** Saves a charge; its fee, net and payout are kept (they're set from balance transactions) */
export async function saveCharge(charge: Stripe.Charge, at: Date): Promise<void> {
  const row = chargeRow(charge, at)
  await prisma.stripeCharge.upsert({ where: { id: row.id }, create: row, update: row })
}

export async function saveBalance(balance: Stripe.Balance, now: Date): Promise<void> {
  const row = balanceRow(balance, now)
  await prisma.stripeBalanceDaily.upsert({ where: { date: row.date }, create: row, update: row })
}

/**
 * Sets each charge's fee and net from its balance transaction, and its payout when `payoutId` is given
 * (the transactions of that payout). Transactions of other kinds (refunds, the payout itself) and
 * charges not in the table are skipped. Returns how many charges it updated.
 */
export async function applyChargeTransactions(transactions: Stripe.BalanceTransaction[], payoutId?: string): Promise<number> {
  let updated = 0
  for (const t of transactions) {
    const source = idOf(t.source)
    if (!source || t.type === "payout" || !(source.startsWith("ch_") || source.startsWith("py_"))) continue
    const { count } = await prisma.stripeCharge.updateMany({ where: { id: source }, data: { feeCents: t.fee, netCents: t.net, ...(payoutId ? { payoutId } : {}) } })
    updated += count
  }
  return updated
}
