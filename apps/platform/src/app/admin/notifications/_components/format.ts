import { formatInTimeZone } from "date-fns-tz"
import type { NotificationStatus } from "@prisma/client"
import type { Tone } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE, zoneLabel } from "@/lib/dates"
import type { getRecentNotifications } from "../actions"

type RecentNotification = Awaited<ReturnType<typeof getRecentNotifications>>[number]

/** A notification as the admin lists load it, with its member; Activity's rows also carry the email's delivery */
export type NotificationRow = Omit<RecentNotification, "delivery"> & { delivery?: RecentNotification["delivery"] }

/** "Oct 12, 7:30 PM CT": admin times are always Central */
export function centralTime(value: Date | string, pattern = "MMM d, h:mm a") {
  const date = new Date(value)
  return `${formatInTimeZone(date, DEFAULT_TIMEZONE, pattern)} ${zoneLabel(date, DEFAULT_TIMEZONE)}`
}

/** "REGISTRATION_CONFIRMED" → "Registration confirmed" */
export function typeLabel(type: string) {
  const words = type.toLowerCase().replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const STATUS: Record<NotificationStatus, { label: string; tone: Tone }> = {
  PENDING: { label: "Pending", tone: "warning" },
  SENT: { label: "Sent", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
}

export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`

/** The page's tabs, in order. The open one is kept in the URL as ?tab= */
export const NOTIFICATION_TABS = ["activity", "scheduled", "delivery", "compose", "settings", "cleanup"] as const
export type NotificationTab = (typeof NOTIFICATION_TABS)[number]

/** Rows with the same message and send time belong to one scheduled send (one row per member and channel) */
export function scheduledSendKey(n: { title: string; body: string; actionUrl: string | null; scheduledFor: Date | string | null }) {
  return [n.title, n.body, n.actionUrl ?? "", n.scheduledFor ? new Date(n.scheduledFor).toISOString() : ""].join("\u0000")
}
