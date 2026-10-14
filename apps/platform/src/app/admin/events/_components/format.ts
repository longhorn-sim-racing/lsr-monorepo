import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE, zoneLabel } from "@/lib/dates"

/** Formats a date in Central time (the club's zone) with a date-fns pattern. */
export function central(date: Date | string, pattern: string) {
  return formatInTimeZone(new Date(date), DEFAULT_TIMEZONE, pattern)
}

const CT = (date: Date | string) => zoneLabel(new Date(date), DEFAULT_TIMEZONE)

/** "Sat, Oct 17, 2026" */
export function centralDay(date: Date | string) {
  return central(date, "EEE, MMM d, yyyy")
}

/** "Oct 17, 2026, 7:00 PM CT" */
export function centralDateTime(date: Date | string) {
  return `${central(date, "MMM d, yyyy, h:mm a")} ${CT(date)}`
}

/** "7:00 PM CT" */
export function centralTime(date: Date | string) {
  return `${central(date, "h:mm a")} ${CT(date)}`
}

/** "7:00–9:00 PM CT", or "7:00 PM – Oct 18, 1:00 AM CT" when it ends on another day */
export function centralTimeRange(start: Date | string, end: Date | string) {
  const sameDay = central(start, "yyyy-MM-dd") === central(end, "yyyy-MM-dd")
  if (!sameDay) return `${central(start, "h:mm a")} – ${central(end, "MMM d, h:mm a")} ${CT(end)}`
  const sameHalf = central(start, "a") === central(end, "a")
  return sameHalf
    ? `${central(start, "h:mm")}–${central(end, "h:mm a")} ${CT(end)}`
    : `${central(start, "h:mm a")} – ${central(end, "h:mm a")} ${CT(end)}`
}
