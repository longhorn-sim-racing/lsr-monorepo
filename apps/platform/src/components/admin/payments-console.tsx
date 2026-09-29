import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import type { PaymentStatus } from "@prisma/client";
import { ChevronLeft, ChevronRight, CreditCard, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PaymentsFilters } from "@/components/admin/payments-filters";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { PAYMENT_KIND_LABELS, paymentKind, stripeDashboardUrl } from "@/lib/payments";
import { cn } from "@/lib/utils";
import { PAYMENTS_PAGE_SIZE, type AdminPayment, type PaymentFilters } from "@/server/queries/payments";

type PaymentsConsoleProps = {
  filters: PaymentFilters;
  payments: AdminPayment[];
  total: number;
  succeededCount: number;
  succeededCents: number;
  pageCount: number;
};

const STATUS_STYLES: Record<PaymentStatus, string> = {
  succeeded: "bg-green-500/10 text-green-500 border-green-500/30",
  pending: "bg-yellow-500/10 text-yellow-500 border-yellow-500/30",
  failed: "bg-red-500/10 text-red-500 border-red-500/30",
  refunded: "bg-white/10 text-white/60 border-white/20",
};

const formatCentral = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, yyyy h:mm a");

function pageHref({ status, kind, q }: PaymentFilters, page: number) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (kind) params.set("kind", kind);
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/payments?${query}` : "/admin/payments";
}

export function PaymentsConsole({
  filters,
  payments,
  total,
  succeededCount,
  succeededCents,
  pageCount,
}: PaymentsConsoleProps) {
  const offset = (filters.page - 1) * PAYMENTS_PAGE_SIZE;
  const firstRow = payments.length ? offset + 1 : 0;
  const lastRow = offset + payments.length;

  return (
    <div className="flex flex-col border border-white/10 bg-black/40 overflow-hidden font-mono text-sm">
      {/* Toolbar */}
      <div className="bg-white/5 p-3 border-b border-white/10 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 border border-white/10">
          <CreditCard size={14} className="text-lsr-orange" />
          <span className="font-bold text-white/80 tracking-wider uppercase">Payments</span>
        </div>
        <div className="h-6 w-px bg-white/10" />
        <PaymentsFilters />
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 divide-x divide-white/10 border-b border-white/10">
        <SummaryStat label="Payments" value={total.toLocaleString()} />
        <SummaryStat label="Succeeded" value={succeededCount.toLocaleString()} />
        <SummaryStat label="Collected" value={formatCents(succeededCents)} highlight />
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-white/5 border-b border-white/10 text-left text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">
              <th className="px-4 py-2 font-bold">Date (CT)</th>
              <th className="px-4 py-2 font-bold">Driver</th>
              <th className="px-4 py-2 font-bold">What</th>
              <th className="px-4 py-2 font-bold text-right">Amount</th>
              <th className="px-4 py-2 font-bold">Status</th>
              <th className="px-4 py-2 font-bold text-right">Stripe</th>
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-white/40">
                  No payments match these filters.
                </td>
              </tr>
            ) : (
              payments.map((payment) => <PaymentRow key={payment.id} payment={payment} />)
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="bg-white/5 border-t border-white/10 px-4 py-2 flex items-center justify-between text-[10px] uppercase tracking-widest text-white/40">
        <span>
          {firstRow}–{lastRow} of {total.toLocaleString()}
        </span>
        <div className="flex items-center gap-3">
          <PagerLink href={pageHref(filters, filters.page - 1)} disabled={filters.page <= 1}>
            <ChevronLeft size={12} /> Prev
          </PagerLink>
          <span>
            Page {filters.page} of {pageCount}
          </span>
          <PagerLink href={pageHref(filters, filters.page + 1)} disabled={filters.page >= pageCount}>
            Next <ChevronRight size={12} />
          </PagerLink>
        </div>
      </div>
    </div>
  );
}

function PaymentRow({ payment }: { payment: AdminPayment }) {
  const meta = (payment.metadata ?? {}) as Record<string, unknown>;
  const kind = paymentKind(payment);
  const what =
    payment.product?.name ??
    payment.eventRegistration?.event.title ??
    (typeof meta.eventTitle === "string" ? meta.eventTitle : null);
  const stripeUrl = stripeDashboardUrl(payment.providerRef);

  return (
    <tr className="border-b border-white/5 last:border-b-0 hover:bg-white/[0.02] align-top">
      <td className="px-4 py-2.5 whitespace-nowrap">
        <div className="text-white/80">{formatCentral(payment.createdAt)}</div>
        {payment.paidAt && (
          <div className="text-[10px] text-white/40">Paid {formatCentral(payment.paidAt)}</div>
        )}
      </td>
      <td className="px-4 py-2.5 max-w-[16rem]">
        <Link
          href={`/drivers/${payment.user.handle}`}
          className="block truncate font-bold text-white hover:text-lsr-orange transition-colors"
        >
          {payment.user.displayName}
        </Link>
        <div className="truncate text-[10px] text-white/40">{payment.user.email}</div>
      </td>
      <td className="px-4 py-2.5">
        {kind && (
          <div className="text-[10px] font-bold uppercase tracking-wider text-white/40">
            {PAYMENT_KIND_LABELS[kind]}
          </div>
        )}
        <div className="text-white/80">{what ?? "—"}</div>
      </td>
      <td className="px-4 py-2.5 text-right whitespace-nowrap">
        <span className="font-bold text-white">{formatCents(payment.amountCents)}</span>
        {meta.priceTier === "returning" && (
          <div>
            <span className="inline-block border border-lsr-orange/30 bg-lsr-orange/10 px-1.5 text-[9px] uppercase tracking-widest text-lsr-orange">
              returning
            </span>
          </div>
        )}
      </td>
      <td className="px-4 py-2.5">
        <Badge variant="outline" className={cn("rounded-none uppercase tracking-wider text-[10px]", STATUS_STYLES[payment.status])}>
          {payment.status}
        </Badge>
        {typeof meta.duplicateOfEntitlementId === "string" && payment.status === "succeeded" && (
          <div
            className="mt-1 text-[10px] font-bold uppercase tracking-wider text-red-400"
            title="They already had this entry or membership when this payment went through. Refund it in Stripe."
          >
            Duplicate — refund
          </div>
        )}
      </td>
      <td className="px-4 py-2.5 text-right whitespace-nowrap">
        {stripeUrl ? (
          <a
            href={stripeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-white/50 hover:text-lsr-orange transition-colors"
          >
            Open <ExternalLink size={10} />
          </a>
        ) : (
          <span className="text-white/20">{payment.provider === "stripe" ? "—" : payment.provider}</span>
        )}
      </td>
    </tr>
  );
}

function SummaryStat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">{label}</p>
      <p className={cn("mt-1 text-xl font-bold", highlight ? "text-lsr-orange" : "text-white")}>{value}</p>
    </div>
  );
}

function PagerLink({ href, disabled, children }: { href: string; disabled: boolean; children: React.ReactNode }) {
  if (disabled) {
    return <span className="inline-flex items-center gap-1 text-white/15">{children}</span>;
  }
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-white/60 hover:text-lsr-orange transition-colors">
      {children}
    </Link>
  );
}
