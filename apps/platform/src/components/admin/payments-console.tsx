import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import type { PaymentStatus } from "@prisma/client"
import { ExternalLink } from "lucide-react"
import { Badge, EmptyState, Notice, Panel, Stat, StatRow, Table, TD, TH, THead, TR, type Tone } from "@/components/admin/kit"
import { PaymentsFilters } from "@/components/admin/payments-filters"
import { PaymentsPager } from "@/app/admin/payments/_components/payments-pager"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { formatCents } from "@/lib/money"
import { PAYMENT_KIND_LABELS, paymentKind, stripeDashboardUrl } from "@/lib/payments"
import { PAYMENTS_PAGE_SIZE, type AdminPayment, type PaymentFilters } from "@/server/queries/payments"

/** An open Stripe dispute on a payment, by its PaymentIntent id (from the Stripe sync) */
type OpenDispute = { id: string; status: string; evidenceDueBy: Date | null }

type PaymentsConsoleProps = {
  filters: PaymentFilters
  payments: AdminPayment[]
  total: number
  succeededCount: number
  succeededCents: number
  pageCount: number
  disputes?: Record<string, OpenDispute>
}

const STATUS: Record<PaymentStatus, { label: string; tone: Tone }> = {
  succeeded: { label: "Succeeded", tone: "success" },
  pending: { label: "Pending", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  refunded: { label: "Refunded", tone: "neutral" },
}

const formatCentral = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, yyyy h:mm a")

const DUPLICATE_REFUND_HINT = "They already had this entry or membership when this payment went through. Refund it in Stripe."
const DUPLICATE_NO_ENTRY_HINT =
  "This was flagged as a duplicate, but the entry it duplicated has since ended. They've paid and have no entry: re-enter them or refund."

export function PaymentsConsole({ filters, payments, total, succeededCount, succeededCents, pageCount, disputes = {} }: PaymentsConsoleProps) {
  const offset = (filters.page - 1) * PAYMENTS_PAGE_SIZE
  const firstRow = payments.length ? offset + 1 : 0
  const lastRow = offset + payments.length
  const filtered = Boolean(filters.status || filters.kind || filters.q)
  const toRefund = payments.filter((p) => p.duplicate === "refund").length
  const noEntry = payments.filter((p) => p.duplicate === "no-entry").length

  return (
    <div className="flex min-w-0 flex-col">
      <StatRow>
        <Stat label="Payments" value={total.toLocaleString()} hint={filtered ? "Matching these filters" : undefined} />
        <Stat label="Succeeded" value={succeededCount.toLocaleString()} />
        <Stat label="Collected" value={formatCents(succeededCents)} hint="Succeeded payments, before refunds and fees" />
      </StatRow>

      <PaymentsFilters />

      {(toRefund > 0 || noEntry > 0) && (
        <Notice tone="warning" title="Possible duplicate payments on this page" className="mb-3">
          {toRefund > 0 && `${toRefund} marked "Duplicate: refund" already had what they paid for. `}
          {noEntry > 0 && `${noEntry} marked "Paid, no entry" paid but have no entry now. `}
          Check each one, then refund in Stripe or re-enter the driver.
        </Notice>
      )}

      <Panel className="overflow-hidden">
        <Table className="rounded-none border-0" minWidth={760}>
          <THead>
            <TH>Date (CT)</TH>
            <TH>Driver</TH>
            <TH>What</TH>
            <TH className="text-right">Amount</TH>
            <TH>Status</TH>
            <TH className="text-right">Stripe</TH>
          </THead>
          <tbody>
            {payments.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  {filtered ? (
                    <EmptyState title="No payments match these filters" description="Try a different search, or clear the filters." />
                  ) : (
                    <EmptyState title="No payments yet" description="Payments show up here as soon as someone checks out." />
                  )}
                </td>
              </tr>
            ) : (
              payments.map((payment) => <PaymentRow key={payment.id} payment={payment} dispute={payment.providerRef ? disputes[payment.providerRef] : undefined} />)
            )}
          </tbody>
        </Table>
        <div className="border-t border-admin-row">
          <PaymentsPager
            filters={filters}
            pageCount={pageCount}
            summary={`${firstRow.toLocaleString()}–${lastRow.toLocaleString()} of ${total.toLocaleString()} · page ${filters.page} of ${pageCount}`}
          />
        </div>
      </Panel>
    </div>
  )
}

function PaymentRow({ payment, dispute }: { payment: AdminPayment; dispute?: OpenDispute }) {
  const meta = (payment.metadata ?? {}) as Record<string, unknown>
  const kind = paymentKind(payment)
  const what = payment.product?.name ?? payment.eventRegistration?.event.title ?? (typeof meta.eventTitle === "string" ? meta.eventTitle : null)
  const stripeUrl = stripeDashboardUrl(payment.providerRef)
  const status = STATUS[payment.status]

  return (
    <TR className="align-top">
      <TD className="whitespace-nowrap">
        <div>{formatCentral(payment.createdAt)}</div>
        {payment.paidAt && <div className="text-xs text-admin-subtle">Paid {formatCentral(payment.paidAt)}</div>}
      </TD>
      <TD className="max-w-64">
        <Link href={`/admin/users/${payment.userId}/edit`} className="block truncate font-semibold hover:underline">
          {payment.user.displayName}
        </Link>
        <div className="truncate text-xs text-admin-subtle">{payment.user.email}</div>
      </TD>
      <TD>
        <div>{what ?? "—"}</div>
        {kind && <div className="text-xs text-admin-subtle">{PAYMENT_KIND_LABELS[kind]}</div>}
      </TD>
      <TD className="whitespace-nowrap text-right">
        <div className="font-semibold">{formatCents(payment.amountCents)}</div>
        {meta.priceTier === "returning" && (
          <Badge tone="info" className="mt-1">
            Returning rate
          </Badge>
        )}
      </TD>
      <TD>
        <div className="flex flex-col items-start gap-1">
          <Badge tone={status.tone}>{status.label}</Badge>
          {payment.duplicate === "refund" && (
            <span title={DUPLICATE_REFUND_HINT}>
              <Badge tone="danger">Duplicate: refund</Badge>
            </span>
          )}
          {payment.duplicate === "no-entry" && (
            <span title={DUPLICATE_NO_ENTRY_HINT}>
              <Badge tone="warning">Paid, no entry</Badge>
            </span>
          )}
          {dispute && (
            <a href={`https://dashboard.stripe.com/disputes/${dispute.id}`} target="_blank" rel="noopener noreferrer" title="The cardholder disputed this charge. Respond in Stripe.">
              <Badge tone="danger">
                Disputed{dispute.evidenceDueBy ? `: respond by ${formatInTimeZone(dispute.evidenceDueBy, DEFAULT_TIMEZONE, "MMM d")}` : ""}
              </Badge>
            </a>
          )}
        </div>
      </TD>
      <TD className="whitespace-nowrap text-right">
        {stripeUrl ? (
          <a href={stripeUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium hover:underline">
            Open
            <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : (
          <span className="text-admin-subtle">{payment.provider === "stripe" ? "—" : payment.provider}</span>
        )}
      </TD>
    </TR>
  )
}
