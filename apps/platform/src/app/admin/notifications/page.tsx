import type { Metadata } from "next"
import { Suspense } from "react"
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
import { BOUNCE_LIST_DAYS } from "./_components/notification-delivery"
import { DeliveryPanel, DeliveryPanelLoading } from "./_components/delivery-panel"
import { bouncedRecipientCount } from "@/server/connectors/resend/delivery"

const DAY_MS = 86_400_000

/** The Delivery tab's badge: how many addresses bounced (one grouped count; the tab's own reads stream in later). None if it can't load */
const bounceCount = () =>
  bouncedRecipientCount(new Date(Date.now() - BOUNCE_LIST_DAYS * DAY_MS)).catch((error) => {
    console.error("[notifications] Couldn't count bounces:", error)
    return undefined
  })

export const metadata: Metadata = { title: "Notifications" }

export const dynamic = "force-dynamic"
// Sending to every member takes several batch calls; leave room beyond the default time limit
export const maxDuration = 60

export default async function AdminNotificationsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireOfficerPage()
  const [{ tab }, stats, recentNotifications, scheduledNotifications, emailSettings, emailUsage, bounces] = await Promise.all([
    searchParams,
    getNotificationStats(),
    getRecentNotifications(),
    getScheduledNotifications(),
    getEmailSettings(),
    getEmailUsage(),
    bounceCount(),
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
        counts={{ scheduled: scheduledSends, delivery: bounces }}
        panels={{
          activity: <NotificationActivity notifications={recentNotifications} total={stats.total} />,
          scheduled: <NotificationScheduled notifications={scheduledNotifications} />,
          delivery: (
            <Suspense fallback={<DeliveryPanelLoading />}>
              <DeliveryPanel />
            </Suspense>
          ),
          compose: <NotificationComposer emailUsage={emailUsage} keptForReceipts={TRANSACTIONAL_HEADROOM} />,
          settings: <NotificationSettings settings={emailSettings} resendKeyConfigured={!!process.env.RESEND_API_KEY} />,
          cleanup: <NotificationCleanup />,
        }}
      />
    </>
  )
}
