import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { ExternalLink } from "lucide-react"
import { Badge, Button, Notice, Panel, PanelHeader, type Tone } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { formatCents } from "@/lib/money"
import { stripeConnector } from "@/server/connectors/stripe/connector"
import { DISPUTE_STATUS_LABEL, PAYOUT_STATUS_LABEL, RESPOND_STATUSES, stripeSnapshot, UPCOMING_PAYOUT_STATUSES } from "@/server/connectors/stripe/read"

/**
 * The Stripe panel on Money → Payments (Jack 2.0, design §12.3, §13): the balance, payouts, refunds and
 * disputes from the daily read-only sync, so officers see what Jack's stripe_overview sees. Everything
 * here is read only; acting on it happens in the Stripe dashboard.
 */

/** Payout arrival dates are midnight UTC: shown as that calendar day, or Central would say the day before */
const utcDay = (date: Date) => formatInTimeZone(date, "UTC", "MMM d")
const central = (date: Date, pattern = "MMM d") => formatInTimeZone(date, DEFAULT_TIMEZONE, pattern)

const PAYOUT_TONE: Record<string, Tone> = { paid: "success", pending: "neutral", in_transit: "info", failed: "danger", canceled: "neutral" }
const REFUND_TONE: Record<string, Tone> = { succeeded: "success", pending: "neutral", requires_action: "warning", failed: "danger", canceled: "neutral" }
const disputeTone = (status: string): Tone => (RESPOND_STATUSES.includes(status) ? "danger" : status === "won" ? "success" : status === "lost" ? "neutral" : "warning")

const DAY_MS = 86_400_000

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div className="flex min-w-0 flex-col">
      <h3 className="px-4 pb-1 pt-3 text-xs font-semibold text-muted-foreground">{title}</h3>
      {children.length ? <ul className="flex flex-col">{children}</ul> : <p className="px-4 pb-3 text-[13px] text-muted-foreground">{empty}</p>}
    </div>
  )
}

function Row({ primary, secondary, meta }: { primary: React.ReactNode; secondary?: React.ReactNode; meta: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 border-t border-admin-row px-4 py-2 text-[13px]">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold tabular-nums">{primary}</span>
        {secondary && <span className="truncate text-xs text-admin-subtle">{secondary}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">{meta}</span>
    </li>
  )
}

export async function StripePanel() {
  const now = new Date()
  const [status, snapshot] = await Promise.all([stripeConnector.status(), stripeSnapshot({ days: 60, limit: 6, now })])
  const empty = !snapshot.balance && !snapshot.payouts.length && !snapshot.disputes.length

  if (empty) {
    return (
      <Notice
        className="mb-4"
        title={status.state === "not_configured" ? "Stripe isn't connected yet" : "No Stripe data yet"}
        action={
          <Button size="sm" asChild>
            <Link href="/admin/connections">Connections</Link>
          </Button>
        }
      >
        {status.state === "not_configured"
          ? "Once an admin adds the read-only Stripe key, the balance, payouts, refunds and disputes show here."
          : status.state === "off"
            ? "The Stripe connection is switched off. An admin can switch it on under System → Connections."
            : "The daily Stripe sync hasn't run yet."}
      </Notice>
    )
  }

  const upcoming = snapshot.payouts.filter((p) => UPCOMING_PAYOUT_STATUSES.includes(p.status)).sort((a, b) => a.arrivalDate.getTime() - b.arrivalDate.getTime())
  const respond = snapshot.disputes.filter((d) => RESPOND_STATUSES.includes(d.status))
  const synced = status.lastSyncAt ? `synced ${central(new Date(status.lastSyncAt), "MMM d, h:mm a")} CT` : "not synced yet"
  const stale = status.state === "off" ? " · the connection is switched off" : status.state === "error" ? " · the last sync failed" : ""

  return (
    <>
      {respond.map((d) => (
        <Notice
          key={d.id}
          tone="danger"
          className="mb-3"
          title={`A ${formatCents(d.amountCents)} dispute needs a response${d.evidenceDueBy ? ` by ${central(d.evidenceDueBy, "EEE, MMM d")}` : ""}`}
          action={
            <Button size="sm" asChild>
              <a href={`https://dashboard.stripe.com/disputes/${d.id}`} target="_blank" rel="noopener noreferrer">
                Respond in Stripe
                <ExternalLink aria-hidden />
              </a>
            </Button>
          }
        >
          {[d.member, d.item, d.reason.replace(/_/g, " ")].filter(Boolean).join(" · ")}
          {d.evidenceDueBy && ` · ${Math.max(0, Math.ceil((d.evidenceDueBy.getTime() - now.getTime()) / DAY_MS))} days left`}
        </Notice>
      ))}

      <Panel className="mb-4">
        <PanelHeader
          title="Stripe"
          description={`Read only, from the daily sync (${synced})${stale}`}
          actions={
            <Button size="sm" variant="ghost" asChild>
              <a href="https://dashboard.stripe.com/balance/overview" target="_blank" rel="noopener noreferrer">
                Balance in Stripe
                <ExternalLink aria-hidden />
              </a>
            </Button>
          }
        />
        <div className="grid grid-cols-1 gap-px border-b border-admin-row bg-admin-row sm:grid-cols-3">
          <div className="flex flex-col gap-0.5 bg-card px-4 py-3">
            <span className="text-xs font-medium text-muted-foreground">Available</span>
            <span className="text-xl font-semibold tabular-nums">{snapshot.balance ? formatCents(snapshot.balance.availableCents) : "—"}</span>
            <span className="text-xs text-admin-subtle">{snapshot.balance ? `${formatCents(snapshot.balance.pendingCents)} pending · ${utcDay(snapshot.balance.date)}` : "No balance synced"}</span>
          </div>
          <div className="flex flex-col gap-0.5 bg-card px-4 py-3">
            <span className="text-xs font-medium text-muted-foreground">Next payout</span>
            <span className="text-xl font-semibold tabular-nums">{upcoming[0] ? formatCents(upcoming[0].amountCents) : "None"}</span>
            <span className="text-xs text-admin-subtle">{upcoming[0] ? `${PAYOUT_STATUS_LABEL[upcoming[0].status]}, arrives ${utcDay(upcoming[0].arrivalDate)}` : "Nothing on its way"}</span>
          </div>
          <div className="flex flex-col gap-0.5 bg-card px-4 py-3">
            <span className="text-xs font-medium text-muted-foreground">Open disputes</span>
            <span className="text-xl font-semibold tabular-nums">{snapshot.openDisputes}</span>
            <span className="text-xs text-admin-subtle">{respond.length ? `${respond.length} need a response` : "None need a response"}</span>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 lg:divide-x lg:divide-admin-row">
          <Section title="Payouts" empty="No payouts in the last 60 days.">
            {snapshot.payouts.map((p) => (
              <Row
                key={p.id}
                primary={formatCents(p.amountCents)}
                secondary={`${p.status === "paid" ? "Arrived" : "Arrives"} ${utcDay(p.arrivalDate)}${p.charges ? ` · ${p.charges} ${p.charges === 1 ? "charge" : "charges"}` : ""}`}
                meta={
                  <>
                    <Badge tone={PAYOUT_TONE[p.status] ?? "neutral"}>{PAYOUT_STATUS_LABEL[p.status] ?? p.status}</Badge>
                    {p.failureCode && <span className="text-xs text-tone-danger-foreground">{p.failureCode.replace(/_/g, " ")}</span>}
                  </>
                }
              />
            ))}
          </Section>
          <Section title="Refunds" empty="No refunds in the last 60 days.">
            {snapshot.refunds.map((r) => (
              <Row
                key={r.id}
                primary={formatCents(r.amountCents)}
                secondary={`${r.member ?? "Not a site checkout"} · ${central(r.createdAt)}`}
                meta={<Badge tone={REFUND_TONE[r.status] ?? "neutral"}>{r.status === "succeeded" ? "Refunded" : r.status.replace(/_/g, " ")}</Badge>}
              />
            ))}
          </Section>
          <Section title="Disputes" empty="No disputes in the last 60 days.">
            {snapshot.disputes.map((d) => (
              <Row
                key={d.id}
                primary={formatCents(d.amountCents)}
                secondary={`${d.member ?? "Not a site checkout"} · ${d.reason.replace(/_/g, " ")}`}
                meta={
                  <>
                    <Badge tone={disputeTone(d.status)}>{DISPUTE_STATUS_LABEL[d.status] ?? d.status}</Badge>
                    {RESPOND_STATUSES.includes(d.status) && d.evidenceDueBy && <span className="text-xs text-tone-danger-foreground">by {central(d.evidenceDueBy)}</span>}
                  </>
                }
              />
            ))}
          </Section>
        </div>
      </Panel>
    </>
  )
}
