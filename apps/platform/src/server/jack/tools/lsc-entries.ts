import type { PaymentStatus } from "@prisma/client"
import { z } from "zod"
import { prisma } from "@/server/db"
import { listSeasonEntrants, type EntryStatus, type SeasonEntrant } from "@/server/services/league-entry.service"
import { forModel, forModelWithList, plural, tableDisplay } from "./display"
import { DEFAULT_LEAGUE, resolveLeagueSeason } from "./seasons"
import { addDays, centralDate, centralDateInput, ct, dollars, startOfCentralDay } from "./time"
import type { JackTool } from "./types"

/**
 * lsc_entries: a league season's entry forms and entries (#161), built on listSeasonEntrants, the same
 * list /admin/league-entries shows. "Paid" = an active league_access entitlement from a Stripe
 * payment; "manual" = entered by an officer; "ended" = refunded or revoked; "none" = form only.
 */

const meta = (value: unknown) => (value ?? {}) as Record<string, unknown>

export function entrantSummary(entrants: SeasonEntrant[], since: Date) {
  const forms = entrants.filter((e) => e.application)
  const status = (s: EntryStatus) => entrants.filter((e) => e.status === s)
  const paid = status("paid")
  const bySource: Record<string, number> = {}
  for (const e of forms) bySource[e.application!.source] = (bySource[e.application!.source] ?? 0) + 1
  return {
    forms: { total: forms.length, bySource, newSince: forms.filter((e) => e.application!.createdAt >= since).length },
    entries: {
      entered: paid.length + status("manual").length,
      paid: paid.length,
      manual: status("manual").length,
      ended: status("ended").length,
      formButNotEntered: forms.filter((e) => e.status === "none" || e.status === "ended").length,
    },
    paidIn: {
      dollars: dollars(paid.reduce((sum, e) => sum + (e.entry?.payment?.amountCents ?? 0), 0)),
      returningRate: paid.filter((e) => meta(e.entry?.payment?.metadata).priceTier === "returning").length,
    },
  }
}

export function driverRow(e: SeasonEntrant) {
  const paymentMeta = meta(e.entry?.payment?.metadata)
  return {
    name: e.user.displayName,
    handle: e.user.handle,
    email: e.user.email,
    eid: e.user.eid,
    status: e.status,
    formSource: e.application?.source ?? null,
    formAt: ct(e.application?.createdAt),
    discord: e.application?.discordUsername ?? null,
    paidDollars: e.entry?.payment ? dollars(e.entry.payment.amountCents) : null,
    paidAt: ct(e.entry?.payment?.paidAt ?? (e.status === "manual" ? e.entry?.validFrom : null)),
    returningRate: paymentMeta.priceTier === "returning",
    note: typeof meta(e.entry?.meta).note === "string" ? (meta(e.entry?.meta).note as string) : null,
  }
}

/** What happened to a checkout that didn't end in an entry, from its status and the webhook's audit entry */
export function checkoutOutcome(status: PaymentStatus, auditAction: string | undefined): string {
  if (status === "pending") return "started, not finished (open or abandoned)"
  if (status === "failed") return auditAction === "PAYMENT_EXPIRED" ? "expired" : auditAction === "PAYMENT_FAILED" ? "payment failed" : "failed or expired"
  return status
}

const input = z.object({
  season: z.string().max(80).optional().describe("Season slug, e.g. lone-star-cup-s3 (default: the open season, the one entry is for now)"),
  league: z.string().max(80).default(DEFAULT_LEAGUE).describe("League slug"),
  since: centralDateInput.optional().describe("Central date that starts the 'recent' window for checkouts and new forms (default: 14 days ago)"),
  listDrivers: z.boolean().default(true).describe("List every driver with their entry status, email and EID"),
})

export const lscEntriesTool: JackTool<z.infer<typeof input>> = {
  name: "lsc_entries",
  description:
    "Lone Star Cup entry for a season: entry forms (by source), who is entered (paid through Stripe, or entered by hand by an officer), ended entries, forms without an entry, money paid in, recent checkouts that were started but not paid (pending, expired or failed), and flagged duplicate payments. Optionally lists every driver with email, EID and status. This is the definition of 'paid for LSC'; use it rather than SQL for entry questions.",
  input,
  async run({ season: seasonSlug, league: leagueSlug, since: sinceInput, listDrivers }) {
    const now = new Date()
    const resolved = await resolveLeagueSeason(leagueSlug, seasonSlug, now)
    if (!resolved.ok) return { isError: true, forModel: resolved.error, label: "LSC lookup failed", displays: [] }
    const { league, season, open, seasons } = resolved

    const sinceDate = sinceInput ?? addDays(centralDate(now), -14)
    const since = startOfCentralDay(sinceDate)

    const [roster, product, checkouts, duplicates] = await Promise.all([
      listSeasonEntrants(season.id),
      prisma.product.findFirst({ where: { type: "LEAGUE_FEE", leagueId: league.id } }),
      prisma.payment.findMany({
        where: { product: { leagueId: league.id }, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        select: { id: true, userId: true, status: true, amountCents: true, createdAt: true, user: { select: { displayName: true, email: true } } },
      }),
      prisma.payment
        .findMany({ where: { product: { leagueId: league.id }, status: "succeeded" }, select: { metadata: true } })
        .then((rows) => rows.filter((p) => typeof meta(p.metadata).duplicateOfEntitlementId === "string").length),
    ])
    const entrants = roster?.entrants ?? []
    const statusByUser = new Map(entrants.map((e) => [e.user.id, e.status]))

    const unpaid = checkouts.filter((p) => p.status === "pending" || p.status === "failed")
    const audits = unpaid.length
      ? await prisma.auditLog.findMany({
          where: { entityType: "PAYMENT", entityId: { in: unpaid.map((p) => p.id) }, actionType: { in: ["PAYMENT_EXPIRED", "PAYMENT_FAILED"] } },
          select: { entityId: true, actionType: true },
        })
      : []
    const auditByPayment = new Map(audits.map((a) => [a.entityId, a.actionType]))

    const byStatus: Record<string, number> = {}
    for (const p of checkouts) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1

    const productMeta = meta(product?.metadata)
    const summary = entrantSummary(entrants, since)
    const drivers = entrants.map(driverRow)
    const result = {
      league: league.name,
      season: { slug: season.slug, name: season.name, startsAt: ct(season.startAt), endsAt: ct(season.endAt), entryOpenNow: open },
      otherSeasons: seasons.filter((s) => s !== season.slug),
      price: product
        ? {
            product: product.name,
            dollars: dollars(product.amountCents),
            returningDollars: typeof productMeta.returningAmountCents === "number" ? dollars(productMeta.returningAmountCents) : null,
            onSale: product.active,
          }
        : null,
      ...summary,
      checkouts: {
        since: sinceDate,
        note: "Checkouts for this league's entry product started since then. Payments aren't tied to a season; these are the league's.",
        started: checkouts.length,
        byStatus,
        notPaid: unpaid.map((p) => ({
          name: p.user.displayName,
          email: p.user.email,
          startedAt: ct(p.createdAt),
          outcome: checkoutOutcome(p.status, auditByPayment.get(p.id)),
          enteredNow: ["paid", "manual"].includes(statusByUser.get(p.userId) ?? "none"),
        })),
      },
      flaggedDuplicatePayments: { allTime: duplicates, note: "Paid while already entered; /admin/payments shows which still need a refund in Stripe." },
      drivers: listDrivers ? drivers : undefined,
    }

    return {
      forModel: listDrivers ? forModelWithList(result, "drivers", drivers) : forModel(result),
      label: `Looked up ${season.name} entries (${summary.entries.entered} entered, ${plural(summary.forms.total, "form")})`,
      displays: [
        tableDisplay(
          drivers,
          [
            { header: "Driver", value: (d) => d.name },
            { header: "Email", value: (d) => d.email },
            { header: "Entry", value: (d) => d.status },
            { header: "Form", value: (d) => d.formSource },
            { header: "Paid", value: (d) => (d.paidDollars === null ? null : `$${d.paidDollars.toFixed(2)}`) },
          ],
          `${season.name}: ${summary.entries.paid} paid, ${summary.entries.manual} manual, ${summary.entries.formButNotEntered} form only`,
        ),
      ],
    }
  },
}
