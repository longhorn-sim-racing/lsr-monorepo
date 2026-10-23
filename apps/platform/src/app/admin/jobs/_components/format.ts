import { formatDistance } from "date-fns"
import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"

/** "2 minutes ago", "in 5 hours" */
export function relative(date: Date | null | undefined, now: Date): string | null {
  return date ? formatDistance(date, now, { addSuffix: true }) : null
}

/** "Oct 22, 4:10 PM CT" */
export function when(date: Date | null | undefined): string | null {
  return date ? `${formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, h:mm a")} CT` : null
}

/** "850 ms", "12.4 s", "3 min 5 s" */
export function duration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`
}
