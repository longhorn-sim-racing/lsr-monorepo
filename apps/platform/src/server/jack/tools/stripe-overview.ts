import { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"
import { prisma } from "@/server/db"
import { stripeConnector } from "@/server/connectors/stripe/connector"
import { DISPUTE_STATUS_LABEL, PAYOUT_STATUS_LABEL, RESPOND_STATUSES, stripeSnapshot, UPCOMING_PAYOUT_STATUSES, withPayments, type ChargeWithPayment } from "@/server/connectors/stripe/read"
import { forModelWithLists, plural, tableDisplay } from "./display"
import { notConnected, sourceConnection } from "./source-connection"
import { ct, dollars } from "./time"
import type { JackTool } from "./types"

/**
 * stripe_overview (#188, design §7.1, §12.3): the club's Stripe account from the daily sync: balance,
 * payouts (and what each paid out), charges joined to the site's payments, refunds and disputes. Read
 * only, like everything about money: Jack never refunds, pays out or answers a dispute.
 */

const DAY_MS = 86_400_000

const input = z.object({
  show: z
    .enum(["summary", "payouts", "charges", "refunds", "disputes"])
    .default("summary")
    .describe("summary: the balance, payouts on their way and recent, open disputes, recent refunds and the window's charge totals. The others list that kind in full for the window"),
  days: z.number().int().min(1).max(400).default(30).describe("How many days back to look (open disputes and payouts on their way show whatever their age)"),
  payout: z
    .string()
    .trim()
    .regex(/^po_\w+$/, "A payout id starts with po_")
    .optional()
    .describe("A payout's id (po_…, from a payouts list): the charges it paid out, each with the member and what they paid for"),
  limit: z.number().int().min(1).max(100).default(25).describe("Most rows per list"),
})

/** A UTC calendar date: Stripe's payout arrival dates are midnight UTC, so a Central time would show the day before */
const utcDate = (date: Date) => date.toISOString().slice(0, 10)

function chargeRow(c: ChargeWithPayment) {
  return {
    id: c.id,
    created: ct(c.createdAt),
    dollars: dollars(c.amountCents),
    ...(c.amountRefundedCents ? { refundedDollars: dollars(c.amountRefundedCents) } : {}),
    status: c.status,
    ...(c.disputed ? { disputed: true } : {}),
    ...(c.feeCents !== null ? { feeDollars: dollars(c.feeCents), netDollars: dollars(c.netCents ?? c.amountCents - c.feeCents) } : {}),
    for: c.payment ? { member: c.payment.member, item: c.payment.item, paymentStatus: c.payment.status } : c.purpose ? { purpose: c.purpose } : "not a site checkout (no Payment row)",
    payout: c.payout ? { id: c.payout.id, status: c.payout.status, arrives: utcDate(c.payout.arrivalDate) } : null,
    ...(c.dashboardUrl ? { stripe: c.dashboardUrl } : {}),
  }
}

const chargeTable = (rows: ChargeWithPayment[], caption?: string) =>
  tableDisplay(
    rows,
    [
      { header: "Date (CT)", value: (c) => ct(c.createdAt) },
      { header: "For", value: (c) => (c.payment ? `${c.payment.member}: ${c.payment.item}` : c.purpose === "donation" ? "Donation" : (c.purpose ?? "Not from the site")) },
      { header: "Amount", value: (c) => `$${dollars(c.amountCents).toFixed(2)}` },
      { header: "Net", value: (c) => (c.netCents !== null ? `$${dollars(c.netCents).toFixed(2)}` : null) },
      { header: "Status", value: (c) => [c.status, c.amountRefundedCents ? "refunded in part" : "", c.disputed ? "disputed" : ""].filter(Boolean).join(", ") },
    ],
    caption,
  )

export const stripeOverviewTool: JackTool<z.infer<typeof input>> = {
  name: "stripe_overview",
  description:
    "Stripe (the club's payments account), from a daily read-only sync: the balance (available to pay out, and pending), payouts to the bank (on their way, paid, failed; payout gives what one payout paid out, charge by charge), charges with fees and net and who paid for what (joined to the site's payments; donations too), refunds (including failed ones) and disputes (chargebacks and inquiries, with the date a response is due). Use payments_summary for checkouts and who paid; use this for the money side in Stripe. Read only: refunds, payouts and dispute responses happen in the Stripe dashboard, never through Jack.",
  input,
  deferred: true,
  async run({ show, days, payout, limit }) {
    const now = new Date()
    const connection = await sourceConnection(stripeConnector, "Stripe")
    if (!connection.connected) {
      const anything = (await prisma.stripeBalanceDaily.findFirst({ select: { date: true } })) ?? (await prisma.stripePayout.findFirst({ select: { id: true } }))
      if (!anything) return notConnected(connection, "Stripe data")
    }

    const since = new Date(now.getTime() - days * DAY_MS)
    const base = { connection: connection.note, window: { days, since: ct(since) }, readOnly: "Refunds, payouts and dispute responses happen only in the Stripe dashboard." }

    if (payout) {
      const row = await prisma.stripePayout.findUnique({ where: { id: payout } })
      if (!row) return { isError: true, forModel: `No synced payout ${payout}. List payouts with show: "payouts" to get ids.`, label: "Stripe payout lookup failed", displays: [] }
      const charges = await withPayments(await prisma.stripeCharge.findMany({ where: { payoutId: payout }, orderBy: { createdAt: "asc" } }))
      const net = charges.reduce((n, c) => n + (c.netCents ?? 0), 0)
      const result = {
        ...base,
        payout: { id: row.id, dollars: dollars(row.amountCents), status: PAYOUT_STATUS_LABEL[row.status] ?? row.status, arrives: utcDate(row.arrivalDate), created: ct(row.createdAt), ...(row.failureCode ? { failureCode: row.failureCode } : {}) },
        breakdown: charges.length
          ? { charges: charges.length, grossDollars: dollars(charges.reduce((n, c) => n + c.amountCents, 0)), feeDollars: dollars(charges.reduce((n, c) => n + (c.feeCents ?? 0), 0)), netDollars: dollars(net), otherDollars: dollars(row.amountCents - net), otherMeans: "Refunds, disputes and adjustments in the same payout" }
          : "Not broken down: Stripe lists what a payout paid out only for paid automatic payouts, after the sync reads them (a manual or failed payout never is)",
      }
      return {
        forModel: forModelWithLists(result, [{ key: "charges", items: charges.map(chargeRow) }]),
        label: `Looked at Stripe payout ${row.id} ($${dollars(row.amountCents).toFixed(2)}, ${plural(charges.length, "charge")})`,
        displays: charges.length ? [chargeTable(charges, `Paid out ${utcDate(row.arrivalDate)}`)] : [{ kind: "note", text: "This payout isn't broken down." }],
      }
    }

    if (show === "charges") {
      const charges = await withPayments(await prisma.stripeCharge.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: limit }))
      const total = await prisma.stripeCharge.count({ where: { createdAt: { gte: since } } })
      return {
        forModel: forModelWithLists({ ...base, total }, [{ key: "charges", items: charges.map(chargeRow), whenTrimmed: "Shorten days or lower the limit." }]),
        label: `Looked at Stripe charges (${plural(total, "charge")} in ${days} days)`,
        displays: charges.length ? [chargeTable(charges, total > charges.length ? `${charges.length} of ${total}` : undefined)] : [{ kind: "note", text: `No charges in the last ${days} days.` }],
      }
    }

    const snapshot = await stripeSnapshot({ days, limit, now })
    const payoutRows = snapshot.payouts.map((p) => ({
      id: p.id,
      dollars: dollars(p.amountCents),
      status: PAYOUT_STATUS_LABEL[p.status] ?? p.status,
      arrives: utcDate(p.arrivalDate),
      ...(p.failureCode ? { failureCode: p.failureCode } : {}),
      ...(p.method && p.method !== "standard" ? { method: p.method } : {}),
      chargesPaidOut: p.charges,
    }))
    const disputeRows = snapshot.disputes.map((d) => ({
      id: d.id,
      dollars: dollars(d.amountCents),
      status: DISPUTE_STATUS_LABEL[d.status] ?? d.status,
      reason: d.reason.replace(/_/g, " "),
      opened: ct(d.createdAt),
      ...(RESPOND_STATUSES.includes(d.status) && d.evidenceDueBy ? { respondBy: ct(d.evidenceDueBy), daysLeft: Math.ceil((d.evidenceDueBy.getTime() - now.getTime()) / DAY_MS) } : {}),
      ...(d.member ? { member: d.member, item: d.item } : {}),
      stripe: `https://dashboard.stripe.com/disputes/${d.id}`,
    }))
    const refundRows = snapshot.refunds.map((r) => ({ id: r.id, dollars: dollars(r.amountCents), status: r.status, created: ct(r.createdAt), ...(r.member ? { member: r.member } : {}) }))

    const totals = await prisma.stripeCharge.aggregate({ where: { createdAt: { gte: since }, status: "succeeded" }, _count: true, _sum: { amountCents: true, feeCents: true, amountRefundedCents: true } })
    const donations = await prisma.stripeCharge.aggregate({ where: { createdAt: { gte: since }, status: "succeeded", purpose: "donation" }, _count: true, _sum: { amountCents: true } })
    const balance = snapshot.balance && { asOf: snapshot.balance.date.toISOString().slice(0, 10), availableDollars: dollars(snapshot.balance.availableCents), pendingDollars: dollars(snapshot.balance.pendingCents) }
    const upcoming = payoutRows.filter((p, i) => UPCOMING_PAYOUT_STATUSES.includes(snapshot.payouts[i].status))

    const result = {
      ...base,
      balance,
      chargesInWindow: { succeeded: totals._count, grossDollars: dollars(totals._sum.amountCents ?? 0), feeDollars: dollars(totals._sum.feeCents ?? 0), refundedDollars: dollars(totals._sum.amountRefundedCents ?? 0), donations: { count: donations._count, dollars: dollars(donations._sum.amountCents ?? 0) } },
      openDisputes: snapshot.openDisputes,
      notes: "Payout arrival dates are UTC calendar days. Fees are known once Stripe has the charge's balance transaction (the next sync). A payout that shows paid can still fail within a few days.",
    }
    const lists = [
      ...(show === "summary" || show === "payouts" ? [{ key: "payouts", items: payoutRows }] : []),
      ...(show === "summary" || show === "disputes" ? [{ key: "disputes", items: disputeRows }] : []),
      ...(show === "summary" || show === "refunds" ? [{ key: "refunds", items: refundRows }] : []),
    ]

    const displays: JackToolDisplay[] = []
    if (show === "summary") {
      displays.push({
        kind: "stats",
        items: [
          { label: "Available", value: balance ? `$${balance.availableDollars.toFixed(2)}` : "—", hint: balance ? `as of ${balance.asOf}` : "no balance synced" },
          { label: "Pending", value: balance ? `$${balance.pendingDollars.toFixed(2)}` : "—" },
          { label: "Next payout", value: upcoming.length ? `$${upcoming[upcoming.length - 1].dollars.toFixed(2)}` : "None", hint: upcoming.length ? `arrives ${upcoming[upcoming.length - 1].arrives}` : undefined },
          { label: "Open disputes", value: snapshot.openDisputes },
        ],
      })
    }
    if ((show === "summary" || show === "payouts") && payoutRows.length)
      displays.push(
        tableDisplay(
          payoutRows,
          [
            { header: "Payout", value: (p) => p.id },
            { header: "Amount", value: (p) => `$${p.dollars.toFixed(2)}` },
            { header: "Status", value: (p) => (p.failureCode ? `${p.status} (${p.failureCode.replace(/_/g, " ")})` : p.status) },
            { header: "Arrives (UTC)", value: (p) => p.arrives },
          ],
          "Payouts",
        ),
      )
    if ((show === "summary" || show === "disputes") && disputeRows.length)
      displays.push(
        tableDisplay(
          disputeRows,
          [
            { header: "Dispute", value: (d) => d.member ?? d.id },
            { header: "Amount", value: (d) => `$${d.dollars.toFixed(2)}` },
            { header: "Status", value: (d) => d.status },
            { header: "Respond by", value: (d) => ("respondBy" in d ? d.respondBy : null) },
          ],
          "Disputes",
        ),
      )
    if (show === "refunds" && refundRows.length)
      displays.push(
        tableDisplay(
          refundRows,
          [
            { header: "Refund", value: (r) => r.member ?? r.id },
            { header: "Amount", value: (r) => `$${r.dollars.toFixed(2)}` },
            { header: "Status", value: (r) => r.status },
            { header: "Date (CT)", value: (r) => r.created },
          ],
          "Refunds",
        ),
      )
    if (!displays.length) displays.push({ kind: "note", text: `Nothing in Stripe's ${show} for the last ${days} days.` })

    return {
      forModel: forModelWithLists(result, lists),
      label: `Looked at Stripe (${show === "summary" ? (balance ? `$${balance.availableDollars.toFixed(2)} available` : "no balance yet") : show}, ${days} days)`,
      displays,
    }
  },
}
