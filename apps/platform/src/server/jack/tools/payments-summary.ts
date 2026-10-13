import type { PaymentStatus, ProductType } from "@prisma/client"
import { z } from "zod"
import { PAYMENT_KIND_LABELS, PAYMENT_STATUSES, paymentKind, type PaymentKind } from "@/lib/payments"
import { prisma } from "@/server/db"
import { forModel, forModelWithList, tableDisplay } from "./display"
import { centralDate, centralDateInput, centralRange, ct, dollars } from "./time"
import type { JackTool } from "./types"

/**
 * payments_summary: what came in, by product and status, over a date range, in dollars (#161).
 * Read only; it never moves money. Kinds follow /admin/payments (lib/payments paymentKind).
 */

const MAX_PAYMENTS = 5_000

export type PaymentRow = {
  id: string
  status: PaymentStatus
  amountCents: number
  createdAt: Date
  paidAt: Date | null
  productId: string | null
  providerRef: string | null
  metadata: unknown
  product: { name: string; type: ProductType } | null
  eventRegistration: { event: { title: string } } | null
  user: { displayName: string; email: string }
}

/** The name of what was bought: the product, or the event for a paid registration */
export function itemName(p: Pick<PaymentRow, "product" | "eventRegistration">): string {
  if (p.product) return p.product.name
  if (p.eventRegistration) return `Event fee: ${p.eventRegistration.event.title}`
  return "Event fee"
}

export function summarizePayments(payments: PaymentRow[]) {
  const totals = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s, { count: 0, dollars: 0 }])) as Record<PaymentStatus, { count: number; dollars: number }>
  const groups = new Map<string, { item: string; kind: string; status: PaymentStatus; count: number; cents: number }>()
  const duplicates: { name: string; email: string; item: string; dollars: number; paidAt: string | null }[] = []

  for (const p of payments) {
    totals[p.status].count += 1
    totals[p.status].dollars += p.amountCents
    const item = itemName(p)
    const kind = paymentKind(p) as PaymentKind | null
    const key = `${item}|${p.status}`
    const group = groups.get(key) ?? { item, kind: kind ? PAYMENT_KIND_LABELS[kind] : "Other", status: p.status, count: 0, cents: 0 }
    group.count += 1
    group.cents += p.amountCents
    groups.set(key, group)
    const meta = (p.metadata ?? {}) as Record<string, unknown>
    if (p.status === "succeeded" && typeof meta.duplicateOfEntitlementId === "string") {
      duplicates.push({ name: p.user.displayName, email: p.user.email, item, dollars: dollars(p.amountCents), paidAt: ct(p.paidAt) })
    }
  }
  for (const s of PAYMENT_STATUSES) totals[s].dollars = dollars(totals[s].dollars)

  return {
    totals,
    collectedDollars: totals.succeeded.dollars,
    byItem: [...groups.values()]
      .sort((a, b) => a.item.localeCompare(b.item) || a.status.localeCompare(b.status))
      .map(({ cents, ...g }) => ({ ...g, dollars: dollars(cents) })),
    flaggedDuplicates: duplicates,
  }
}

const KIND_TYPES: Record<PaymentKind, ProductType> = { dues: "ANNUAL_DUES", league: "LEAGUE_FEE", event: "EVENT_FEE" }

/** What a payment was for: its product, or for an event fee the event (from the seat it paid for, or its metadata) */
export function purchaseKey(p: { productId: string | null; metadata: unknown; eventRegistration?: { eventId: string } | null }): string {
  if (p.productId) return `product:${p.productId}`
  const eventId = p.eventRegistration?.eventId ?? (p.metadata as Record<string, unknown> | null)?.eventId
  return `event:${typeof eventId === "string" ? eventId : "unknown"}`
}

type Attempt = { userId: string; status: PaymentStatus; productId: string | null; metadata: unknown; createdAt: Date; amountCents: number; eventRegistration?: { eventId: string } | null }

/**
 * The club's "started a checkout and never paid": someone with a pending or failed checkout for an
 * item they haven't paid for since (a later successful payment for the same item clears it, whenever
 * it came). One row per person and item, with their latest attempt.
 */
export function unpaidCheckouts<T extends Attempt>(attempts: T[], succeeded: Pick<Attempt, "userId" | "productId" | "metadata" | "eventRegistration">[]): T[] {
  const paid = new Set(succeeded.map((p) => `${p.userId}|${purchaseKey(p)}`))
  const latest = new Map<string, T>()
  for (const a of attempts) {
    if (a.status !== "pending" && a.status !== "failed") continue
    const key = `${a.userId}|${purchaseKey(a)}`
    if (paid.has(key)) continue
    const seen = latest.get(key)
    if (!seen || a.createdAt > seen.createdAt) latest.set(key, a)
  }
  return [...latest.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

const input = z.object({
  from: centralDateInput.optional().describe("First Central date (default: the 1st of this month)"),
  to: centralDateInput.optional().describe("Last Central date (default: today)"),
  kind: z.enum(["all", "dues", "league", "event"]).default("all").describe("dues = annual dues, league = league entry (LSC), event = paid event registration"),
  status: z.enum(PAYMENT_STATUSES).optional().describe("Only this status"),
  list: z.boolean().default(false).describe("Also list the payments themselves (name, email, item, amount, status, times)"),
  limit: z.number().int().min(1).max(100).default(25).describe("How many payments to list"),
  unpaidCheckouts: z
    .boolean()
    .default(false)
    .describe("Instead: everyone who started a checkout and never paid for that item (all time unless from/to are given), the club's definition"),
})

export const paymentsSummaryTool: JackTool<z.infer<typeof input>> = {
  name: "payments_summary",
  description:
    "Payments over a date range (Central), in dollars: totals by status (succeeded, pending, failed, refunded), collected money, a breakdown by item (dues, league entry, each paid event) and status, and payments flagged as duplicates that need a refund in Stripe. Succeeded and refunded payments are dated by when they were paid; pending and failed ones by when checkout started. Read only: Jack never refunds or charges. Donations aren't here (they live only in Stripe). unpaidCheckouts lists the people who started a checkout and never paid for that item, by the club's definition (a later successful payment for the same thing clears it); use it for 'who didn't finish paying'.",
  input,
  async run({ from, to, kind, status, list, limit, unpaidCheckouts: unpaidOnly }) {
    const now = new Date()
    if (unpaidOnly) return runUnpaidCheckouts({ from, to, now })
    const range = centralRange({ from: from ?? `${centralDate(now).slice(0, 8)}01`, to }, { fromDaysAgo: 0, toDaysAhead: 0 }, now)
    if (!range.ok) return { isError: true, forModel: range.error, label: "Payments lookup failed", displays: [] }
    const window = { gte: range.start, lte: range.end }

    const kindWhere =
      kind === "all"
        ? {}
        : kind === "event"
          ? { OR: [{ productId: null }, { product: { type: "EVENT_FEE" as const } }, { eventRegistration: { isNot: null } }] }
          : { product: { type: KIND_TYPES[kind] } }

    const payments: PaymentRow[] = await prisma.payment.findMany({
      where: {
        AND: [
          kindWhere,
          status ? { status } : {},
          {
            OR: [
              { status: { in: ["succeeded", "refunded"] }, paidAt: window },
              { status: { in: ["succeeded", "refunded"] }, paidAt: null, createdAt: window },
              { status: { in: ["pending", "failed"] }, createdAt: window },
            ],
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: MAX_PAYMENTS,
      select: {
        id: true,
        status: true,
        amountCents: true,
        createdAt: true,
        paidAt: true,
        productId: true,
        providerRef: true,
        metadata: true,
        product: { select: { name: true, type: true } },
        eventRegistration: { select: { event: { select: { title: true } } } },
        user: { select: { displayName: true, email: true } },
      },
    })

    const summary = summarizePayments(payments)
    const result = {
      range: { from: range.from, to: range.to, timeZone: "America/Chicago" },
      kind,
      status: status ?? "all",
      dateBasis: "paidAt for succeeded and refunded; createdAt (checkout start) for pending and failed",
      count: payments.length,
      ...summary,
      note: "Refunded amounts are the full price even for a partial refund. Refunds happen only in the Stripe dashboard.",
      payments: list
        ? payments.slice(0, limit).map((p) => ({
            name: p.user.displayName,
            email: p.user.email,
            item: itemName(p),
            dollars: dollars(p.amountCents),
            status: p.status,
            startedAt: ct(p.createdAt),
            paidAt: ct(p.paidAt),
            stripe: p.providerRef,
          }))
        : undefined,
    }

    return {
      forModel: result.payments ? forModelWithList(result, "payments", result.payments) : forModel(result),
      label: `Looked up payments (${range.from} to ${range.to}: $${summary.collectedDollars.toFixed(2)} collected, ${summary.totals.succeeded.count} paid)`,
      displays: [
        payments.length
          ? tableDisplay(
              summary.byItem,
              [
                { header: "Item", value: (g) => g.item },
                { header: "Status", value: (g) => g.status },
                { header: "Count", value: (g) => g.count },
                { header: "Amount", value: (g) => `$${g.dollars.toFixed(2)}` },
              ],
              `${range.from} to ${range.to}, Central`,
            )
          : { kind: "note", text: `No payments between ${range.from} and ${range.to}.` },
      ],
    }
  },
}

/** unpaidCheckouts: the people, what they started, and when */
async function runUnpaidCheckouts({ from, to, now }: { from?: string; to?: string; now: Date }) {
  const range = from || to ? centralRange({ from, to }, { fromDaysAgo: 0, toDaysAhead: 0 }, now) : null
  if (range && !range.ok) return { isError: true, forModel: range.error, label: "Payments lookup failed", displays: [] }
  const select = {
    userId: true,
    status: true,
    productId: true,
    metadata: true,
    createdAt: true,
    amountCents: true,
    eventRegistration: { select: { eventId: true, event: { select: { title: true } } } },
    product: { select: { name: true } },
    user: { select: { displayName: true, email: true } },
  } as const
  const [attempts, succeeded] = await Promise.all([
    prisma.payment.findMany({
      where: { status: { in: ["pending", "failed"] }, ...(range?.ok ? { createdAt: { gte: range.start, lte: range.end } } : {}) },
      select,
    }),
    prisma.payment.findMany({ where: { status: "succeeded" }, select: { userId: true, productId: true, metadata: true, eventRegistration: { select: { eventId: true } } } }),
  ])
  const open = unpaidCheckouts(attempts, succeeded)
  const rows = open.map((p) => ({
    name: p.user.displayName,
    email: p.user.email,
    item: p.product?.name ?? (p.eventRegistration ? `Event fee: ${p.eventRegistration.event.title}` : "Event fee"),
    dollars: dollars(p.amountCents),
    lastTry: ct(p.createdAt),
    status: p.status,
  }))
  const people = new Set(open.map((p) => p.userId)).size
  const result = {
    window: range?.ok ? { from: range.from, to: range.to, timeZone: "America/Chicago" } : "all time",
    definition: "Started a checkout (pending or failed) for an item and has no successful payment for that same item, at any time. One row per person and item.",
    people,
    checkouts: rows,
  }
  return {
    forModel: forModelWithList(result, "checkouts", rows),
    label: `Found ${people === 1 ? "1 person" : `${people} people`} who started a checkout and didn't pay`,
    displays: rows.length
      ? [
          tableDisplay(rows, [
            { header: "Name", value: (r) => r.name },
            { header: "Item", value: (r) => r.item },
            { header: "Amount", value: (r) => `$${r.dollars.toFixed(2)}` },
            { header: "Last try (CT)", value: (r) => r.lastTry },
            { header: "Status", value: (r) => r.status },
          ]),
        ]
      : [{ kind: "note" as const, text: "Nobody has an unpaid checkout." }],
  }
}
