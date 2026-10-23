import { formatDistanceToNow } from "date-fns"
import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import type { Tone } from "@/components/admin/kit"
import type { ConnectorStatus } from "@/server/connectors/types"

/** Formatting shared by Content → Streams, the Overview card and the Instagram insights section */

/** "2h 05m", or "45m" under an hour */
export function streamLength(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`
}

/** "+12" or "−3" (a real minus sign), or null */
export function signed(n: number | null): string | null {
  if (n === null) return null
  return n > 0 ? `+${n.toLocaleString("en-US")}` : n < 0 ? `−${Math.abs(n).toLocaleString("en-US")}` : "±0"
}

/** "+25% on the week before", or null when there's nothing to compare with */
export function weekChange(now: number | null, before: number | null): string | null {
  if (now === null || before === null || before <= 0) return null
  const pct = Math.round(((now - before) / before) * 100)
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}% on the week before`
}

/** "Mon, Oct 19, 7:00 PM" (Central) */
export const centralDateTime = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "EEE, MMM d, h:mm a")

/** "Oct 19" for a stored daily date (kept as the Central date at UTC midnight) */
export const dailyDate = (date: Date) => formatInTimeZone(date, "UTC", "MMM d")

export const ago = (date: Date | string | null | undefined) => (date ? formatDistanceToNow(new Date(date), { addSuffix: true }) : null)

export const formatCount = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"))

/** A connector's state as a badge */
export function connectionBadge(state: ConnectorStatus["state"]): { tone: Tone; label: string } {
  if (state === "connected") return { tone: "success", label: "Connected" }
  if (state === "error") return { tone: "danger", label: "Failing" }
  if (state === "off") return { tone: "neutral", label: "Off" }
  return { tone: "warning", label: "Not set up" }
}
