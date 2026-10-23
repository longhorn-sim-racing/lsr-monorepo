import { formatInTimeZone, fromZonedTime } from "date-fns-tz"
import { DEFAULT_TIMEZONE, zoneLabel } from "@/lib/dates"

/** Times for the discord-post track's pages, notes and cards: Central, like the rest of the console */

/** "Mon Oct 26, 6:00 PM CT" */
export function when(date: Date, timeZone = DEFAULT_TIMEZONE): string {
  return `${formatInTimeZone(date, timeZone, "EEE MMM d, h:mm a")} ${zoneLabel(date, timeZone)}`.trim()
}

/** "2026-10-26T18:00", as officers write Central times */
export const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/** A Central local time, or null when it isn't a real time ("2026-02-30T10:00" isn't) */
export function fromCentral(value: string): Date | null {
  if (!LOCAL_TIME.test(value)) return null
  const date = fromZonedTime(value, DEFAULT_TIMEZONE)
  if (Number.isNaN(date.getTime())) return null
  return formatInTimeZone(date, DEFAULT_TIMEZONE, "yyyy-MM-dd'T'HH:mm") === value ? date : null
}

/** A Date as a Central local time for a datetime-local field */
export const toCentral = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "yyyy-MM-dd'T'HH:mm")
