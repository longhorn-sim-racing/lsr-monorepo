import type { Metadata } from "next"
import { PageHeader, Stat, StatRow } from "@/components/admin/kit"
import { requireOfficerPage } from "@/server/auth/guards"
import { getEmailUsage, TRANSACTIONAL_HEADROOM } from "@/server/services/notification.service"
import { getNotificationStats, getRecentNotifications, getScheduledNotifications, getEmailSettings } from "./actions"
import { NotificationActivity } from "./_components/notification-activity"
import { NotificationScheduled } from "./_components/notification-scheduled"
import { NotificationComposer } from "./_components/notification-composer"
import { NotificationSettings } from "./_components/notification-settings"
import { NotificationCleanup } from "./_components/notification-cleanup"
import { NotificationTabs } from "./_components/notification-tabs"
import { NOTIFICATION_TABS, scheduledSendKey, type NotificationTab } from "./_components/format"
import { BOUNCE_LIST_DAYS, DELIVERY_COUNT_DAYS, NotificationDelivery, type DeliveryTabData } from "./_components/notification-delivery"
import { bouncedRecipients, deliveryCounts } from "@/server/connectors/resend/delivery"
import { readConnectorState } from "@/server/connectors/state"

const DAY_MS = 86_400_000

/** The Delivery tab's data: Resend's delivery events (officers only, like the page). If it can't load, the tab shows empty rather than the page failing */
async function loadDeliveryTab(): Promise<DeliveryTabData> {
  const now = Date.now()
  const configured = Boolean(process.env.RESEND_WEBHOOK_SECRET)
  try {
    const [counts, bounces, state] = await Promise.all([
      deliveryCounts(new Date(now - DELIVERY_COUNT_DAYS * DAY_MS)),
      bouncedRecipients(new Date(now - BOUNCE_LIST_DAYS * DAY_MS), 200),
      readConnectorState("resend"),
    ])
    return { configured, lastEventAt: state?.lastSyncAt?.toISOString() ?? null, counts, bounces }
  } catch (error) {
    console.error("[notifications] Couldn't load email delivery:", error)
    return { configured, lastEventAt: null, counts: { emails: 0, byStatus: { complained: 0, bounced: 0, failed: 0, suppressed: 0, clicked: 0, opened: 0, delivered: 0, delayed: 0, sent: 0 } }, bounces: { rows: [], total: 0 } }
  }
}

export const metadata: Metadata = { title: "Notifications" }

export const dynamic = "force-dynamic"
// Sending to every member takes several batch calls; leave room beyond the default time limit
export const maxDuration = 60

export default async function AdminNotificationsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireOfficerPage()
  const [{ tab }, stats, recentNotifications, scheduledNotifications, emailSettings, emailUsage, delivery] = await Promise.all([
    searchParams,
    getNotificationStats(),
    getRecentNotifications(),
    getScheduledNotifications(),
    getEmailSettings(),
    getEmailUsage(),
    loadDeliveryTab(),
  ])

  const initialTab: NotificationTab = NOTIFICATION_TABS.includes(tab as NotificationTab) ? (tab as NotificationTab) : "activity"
  const scheduledSends = new Set(scheduledNotifications.map(scheduledSendKey)).size

  return (
    <>
      <PageHeader
        title="Notifications"
        description={emailSettings.enabled ? "Delivery activity, scheduled sends and announcements to members." : "Email is turned off. Only in-app notifications go out."}
      />

      <StatRow>
        <Stat label="Total" value={stats.total.toLocaleString()} />
        <Stat label="Pending" value={stats.pending.toLocaleString()} hint={scheduledNotifications.length ? `${scheduledNotifications.length.toLocaleString()} scheduled` : undefined} />
        <Stat label="Sent" value={stats.sent.toLocaleString()} />
        <Stat label="Failed" value={stats.failed.toLocaleString()} hint={stats.failed ? "Retry them from Activity" : undefined} />
      </StatRow>

      <NotificationTabs
        initialTab={initialTab}
        counts={{ scheduled: scheduledSends, delivery: delivery.bounces.total }}
        panels={{
          activity: <NotificationActivity notifications={recentNotifications} total={stats.total} />,
          scheduled: <NotificationScheduled notifications={scheduledNotifications} />,
          delivery: <NotificationDelivery data={delivery} />,
          compose: <NotificationComposer emailUsage={emailUsage} keptForReceipts={TRANSACTIONAL_HEADROOM} />,
          settings: <NotificationSettings settings={emailSettings} resendKeyConfigured={!!process.env.RESEND_API_KEY} />,
          cleanup: <NotificationCleanup />,
        }}
      />
    </>
  )
}
