import { bouncedRecipients, deliveryCounts } from "@/server/connectors/resend/delivery"
import { readConnectorState } from "@/server/connectors/state"
import { BOUNCE_LIST_DAYS, DELIVERY_COUNT_DAYS, NotificationDelivery, type DeliveryTabData } from "./notification-delivery"

const DAY_MS = 86_400_000

/** The Delivery tab's data: Resend's delivery events (officers only, like the page). If it can't load, the tab says so, never zeros that look like good news */
export async function loadDeliveryTab(now = Date.now()): Promise<DeliveryTabData> {
  const configured = Boolean(process.env.RESEND_WEBHOOK_SECRET)
  try {
    const [counts, bounces, state] = await Promise.all([
      deliveryCounts(new Date(now - DELIVERY_COUNT_DAYS * DAY_MS)),
      bouncedRecipients(new Date(now - BOUNCE_LIST_DAYS * DAY_MS), 200),
      readConnectorState("resend"),
    ])
    return { configured, enabled: state?.enabled ?? false, lastEventAt: state?.lastSyncAt?.toISOString() ?? null, counts, bounces }
  } catch (error) {
    console.error("[notifications] Couldn't load email delivery:", error)
    return { configured, failed: true }
  }
}

/** The Delivery tab. The page streams it in behind a Suspense boundary, so Activity never waits for these reads */
export async function DeliveryPanel() {
  return <NotificationDelivery data={await loadDeliveryTab()} />
}

export function DeliveryPanelLoading() {
  return (
    <div role="status" className="flex animate-pulse flex-col gap-4">
      <span className="sr-only">Loading email delivery</span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-[72px] rounded-lg border bg-card" />
        ))}
      </div>
      <div className="h-40 rounded-lg border bg-card" />
    </div>
  )
}
