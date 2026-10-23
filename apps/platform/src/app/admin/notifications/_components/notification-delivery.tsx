import Link from "next/link"
import { Badge, Button, CellStack, EmptyState, Notice, Panel, PanelHeader, Stat, StatRow, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { DELIVERY_LABEL, type DeliveryStatus } from "@/lib/email-delivery"
import type { BouncedRecipient } from "@/server/connectors/resend/delivery"
import { centralTime, plural } from "./format"

/** How far back the bounce list and the counts look */
export const BOUNCE_LIST_DAYS = 90
export const DELIVERY_COUNT_DAYS = 30

export type DeliveryTabData = {
  /** RESEND_WEBHOOK_SECRET is set, so Resend's delivery events can arrive */
  configured: boolean
  lastEventAt: string | null
  counts: { emails: number; byStatus: Record<DeliveryStatus, number> }
  bounces: { rows: BouncedRecipient[]; total: number }
}

const percent = (n: number, of: number) => (of ? `${Math.round((n / of) * 1000) / 10}%` : "—")

/**
 * The Delivery tab (Jack 2.0, design §12.4, §13): how the club's email turned out, from Resend's
 * delivery events, and the addresses that bounce. Officers only, like the rest of the page.
 */
export function NotificationDelivery({ data }: { data: DeliveryTabData }) {
  const { byStatus, emails } = data.counts
  const arrived = byStatus.delivered + byStatus.opened + byStatus.clicked
  const refused = byStatus.bounced + byStatus.failed + byStatus.suppressed

  return (
    <div className="flex flex-col gap-4">
      {!data.configured && (
        <Notice
          title="Delivery tracking isn't set up"
          action={
            <Button size="sm" asChild>
              <Link href="/admin/connections">Connections</Link>
            </Button>
          }
        >
          Once Resend&apos;s webhook is added, whether each email arrived shows here and on Activity.
        </Notice>
      )}

      <StatRow className="mb-0">
        <Stat label="Emails reported" value={emails.toLocaleString()} hint={`Last ${DELIVERY_COUNT_DAYS} days${data.lastEventAt ? ` · latest ${centralTime(data.lastEventAt)}` : ""}`} />
        <Stat label="Delivered" value={percent(arrived, emails)} hint={`${arrived.toLocaleString()} reached the receiving server`} />
        <Stat label="Didn't arrive" value={refused.toLocaleString()} hint="Bounced, failed or suppressed" />
        <Stat label="Marked as spam" value={byStatus.complained.toLocaleString()} hint={byStatus.complained ? "Resend pauses accounts over 0.08%" : undefined} />
      </StatRow>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Addresses that didn't get our email"
          description={`Last ${BOUNCE_LIST_DAYS} days, latest first${data.bounces.total > data.bounces.rows.length ? ` (${data.bounces.rows.length} of ${data.bounces.total})` : ""}. Fix the address on the member's profile, or ask them for another one.`}
        />
        {data.bounces.rows.length === 0 ? (
          <EmptyState title="No bounces" description={data.configured ? `Every reported email in the last ${BOUNCE_LIST_DAYS} days arrived.` : "Nothing is reported until delivery tracking is set up."} />
        ) : (
          <Table minWidth={760} className="rounded-none border-0">
            <THead>
              <TH>Address</TH>
              <TH>Email that didn&apos;t arrive</TH>
              <TH>What happened</TH>
              <TH>When</TH>
            </THead>
            <tbody>
              {data.bounces.rows.map((row) => {
                const { label, tone, hint } = DELIVERY_LABEL[row.lastStatus]
                return (
                  <TR key={row.recipient} className="align-top">
                    <TD className="max-w-[240px]">
                      <CellStack
                        primary={row.member ? <Link href={`/admin/users/${row.member.id}/edit`} className="hover:underline">{row.member.displayName}</Link> : row.recipient}
                        secondary={row.member ? row.recipient : "Not a member's address"}
                      />
                    </TD>
                    <TD className="max-w-[260px]">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{row.lastEmail ? row.lastEmail.subject : "Sent outside the site"}</span>
                        <span className="text-xs text-admin-subtle">{plural(row.failed, "email")} didn&apos;t arrive</span>
                      </span>
                    </TD>
                    <TD className="max-w-[280px]">
                      <span title={hint}>
                        <Badge tone={tone}>{label}</Badge>
                      </span>
                      {row.reason && <div className="mt-1 break-words text-xs text-admin-subtle">{row.reason}</div>}
                      {row.deliveredSince && <div className="mt-1 text-xs text-tone-success-foreground">A later email arrived</div>}
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">{centralTime(row.lastAt)}</TD>
                  </TR>
                )
              })}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  )
}
