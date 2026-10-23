import type { Metadata } from "next"
import { formatInTimeZone } from "date-fns-tz"
import { requireOfficerPage } from "@/server/auth/guards"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { formatCentsShort } from "@/lib/money"
import { Badge, PageHeader, StatRow, type Tone } from "@/components/admin/kit"
import { humanizeCode } from "./audit/_components/audit-format"
import { getOverview, RESULTS_LOOKBACK_DAYS } from "./_overview/get-overview"
import { OverviewCards } from "./_overview/overview-cards"
import { OverviewPanel, StatLink } from "./_overview/overview-list"

// The admin layout's " | LSR Admin" template only reaches pages below /admin, not its own page
export const metadata: Metadata = { title: { absolute: "Overview | LSR Admin" } }

const central = (date: Date, pattern: string) => formatInTimeZone(date, DEFAULT_TIMEZONE, pattern)

const PAYMENT_TONE: Record<string, Tone> = { succeeded: "success", pending: "warning", failed: "danger", refunded: "neutral" }
const PAYMENT_LABEL: Record<string, string> = { succeeded: "Paid", pending: "Pending", failed: "Failed", refunded: "Refunded" }
const SOURCE_LABEL: Record<string, string> = { SITE: "On the site", ADMIN: "Added by an officer", GOOGLE_FORM: "Google Form" }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const moreLine = (shown: number, total: number) => (total > shown ? `${total - shown} more not shown` : undefined)

export default async function AdminOverviewPage() {
  await requireOfficerPage()
  const { now, missingResults, drafts, upcoming, applications, payments, activity } = await getOverview()

  const paymentSummary = [
    `${payments.succeeded} paid`,
    payments.succeeded > 0 && `${formatCentsShort(payments.collectedCents)} collected`,
    payments.pending > 0 && `${payments.pending} pending`,
    payments.failed > 0 && `${payments.failed} failed`,
    payments.refunded > 0 && `${payments.refunded} refunded`,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <>
      <PageHeader title="Overview" description={`What needs attention, as of ${central(now, "EEE, MMM d, h:mm a")} CT`} />

      <StatRow>
        <StatLink href="/admin/results" label="Results missing" value={missingResults.count} hint={`Last ${RESULTS_LOOKBACK_DAYS} days`} />
        <StatLink href="/admin/events" label="Draft events" value={drafts.count} />
        <StatLink href="/admin/events" label="Events in the next 7 days" value={upcoming.count} />
        <StatLink href="/admin/league-entries" label="LSC applications" value={applications.thisWeek} hint="Last 7 days" />
        <StatLink href="/admin/payments" label="Payments" value={payments.total} hint={payments.total > 0 ? paymentSummary : "Last 7 days"} />
      </StatRow>

      {/* Two independent columns, so a short panel doesn't stretch to match a long one */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <OverviewPanel
            title="Results missing"
            description={`Racing events from the last ${RESULTS_LOOKBACK_DAYS} days with no ingested results`}
            viewAll={{ href: "/admin/results", label: "Results" }}
            empty="Every recent racing event has its results in."
            more={moreLine(missingResults.items.length, missingResults.count)}
            items={missingResults.items.map((event) => {
              const upload = event.rawResultUploads[0]
              return {
                key: event.id,
                href: upload ? `/admin/results/${upload.id}` : "/admin/results?upload=1",
                primary: event.title,
                secondary: [event.series?.title, central(event.startsAtUtc, "EEE, MMM d")].filter(Boolean).join(" · "),
                meta: <Badge tone="warning">{upload ? "Not ingested" : "No upload"}</Badge>,
              }
            })}
          />

          <OverviewPanel
            title="Coming up"
            description="Running now or starting in the next 7 days"
            viewAll={{ href: "/admin/events", label: "Events" }}
            empty="No events in the next 7 days."
            more={moreLine(upcoming.items.length, upcoming.count)}
            items={upcoming.items.map((event) => {
              const live = event.startsAtUtc <= now
              const unpublished = event.status === "SCHEDULED" && !(event.publishedAt && event.publishedAt <= now)
              const capacity = event.registrationMax ? ` / ${event.registrationMax}` : ""
              const registration = event.registrationEnabled
                ? `${event.registered}${capacity} registered${event.waitlisted > 0 ? ` · ${event.waitlisted} waitlisted` : ""}`
                : event.registered > 0
                  ? `${event.registered} registered`
                  : "No registration"
              return {
                key: event.id,
                href: `/admin/events/${event.id}/manage`,
                primary: event.title,
                secondary: `${central(event.startsAtUtc, "EEE, MMM d, h:mm a")} CT`,
                meta: (
                  <>
                    {live && <Badge tone="success">Live</Badge>}
                    {unpublished && <Badge>Not published</Badge>}
                    <span>{registration}</span>
                  </>
                ),
              }
            })}
          />

          <OverviewPanel
            title="Draft events"
            description="Hidden from the public until published"
            viewAll={{ href: "/admin/events", label: "Events" }}
            empty="No drafts."
            more={moreLine(drafts.items.length, drafts.count)}
            items={drafts.items.map((event) => ({
              key: event.id,
              href: `/admin/events/${event.id}/edit`,
              primary: event.title,
              secondary: event.series?.title ?? "No series",
              meta: (
                <>
                  {event.startsAtUtc < now && <Badge tone="warning">Date passed</Badge>}
                  <span>{central(event.startsAtUtc, "MMM d")}</span>
                </>
              ),
            }))}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <OverviewPanel
            title="LSC applications"
            description={`Newest first · ${plural(applications.thisWeek, "application")} in the last 7 days`}
            viewAll={{ href: "/admin/league-entries", label: "LSC entries" }}
            empty="No applications yet."
            items={applications.items.map((application) => ({
              key: application.id,
              href: `/admin/league-entries?season=${encodeURIComponent(application.season.slug)}`,
              primary: application.user.displayName,
              secondary: `${application.season.name} · ${SOURCE_LABEL[application.source] ?? application.source}`,
              meta: central(application.createdAt, "MMM d, h:mm a"),
            }))}
          />

          <OverviewPanel
            title="Payments"
            description={payments.total > 0 ? `Last 7 days · ${paymentSummary}` : "Last 7 days"}
            viewAll={{ href: "/admin/payments", label: "Payments" }}
            empty="No payments in the last 7 days."
            more={moreLine(payments.items.length, payments.total)}
            items={payments.items.map((payment) => ({
              key: payment.id,
              href: "/admin/payments",
              primary: payment.user.displayName,
              secondary: `${payment.product?.name ?? payment.eventRegistration?.event.title ?? "Payment"} · ${central(payment.createdAt, "MMM d, h:mm a")}`,
              meta: (
                <>
                  <span className="font-semibold text-foreground">{formatCentsShort(payment.amountCents)}</span>
                  <Badge tone={PAYMENT_TONE[payment.status] ?? "neutral"}>{PAYMENT_LABEL[payment.status] ?? payment.status}</Badge>
                </>
              ),
            }))}
          />

          <OverviewPanel
            title="Recent activity"
            description="The latest changes in the audit log"
            viewAll={{ href: "/admin/audit", label: "Audit log" }}
            empty="Nothing in the audit log yet."
            items={activity.map((entry) => ({
              key: entry.id,
              href: `/admin/audit?entry=${entry.id}`,
              primary: entry.summary,
              secondary: `${entry.actor?.displayName ?? "System"} · ${humanizeCode(entry.actionType)} · ${humanizeCode(entry.entityType)}`,
              meta: central(entry.createdAt, "MMM d, h:mm a"),
            }))}
          />
        </div>
      </div>

      {/* Cards the Jack 2.0 tracks add (site traffic, streams, Discord, needs attention); nothing while there are none */}
      <OverviewCards />
    </>
  )
}
