import { formatInTimeZone, fromZonedTime } from "date-fns-tz"
import { z } from "zod"
import { DEFAULT_TIMEZONE } from "@/lib/dates"

/** The club runs on Central time; tools take and give Central dates and times */
export const CLUB_TZ = DEFAULT_TIMEZONE

export const centralDateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-19")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "That isn't a real date")

/** "2026-10-19" in Central time for an instant */
export function centralDate(date: Date): string {
  return formatInTimeZone(date, CLUB_TZ, "yyyy-MM-dd")
}

/** "2026-10-19 18:00 CT", for the model */
export function ct(date: Date): string
export function ct(date: Date | null | undefined): string | null
export function ct(date: Date | null | undefined): string | null {
  return date ? `${formatInTimeZone(date, CLUB_TZ, "yyyy-MM-dd HH:mm")} CT` : null
}

/** "Mon Oct 19, 6:00 PM", for tables in the room */
export function ctShort(date: Date): string {
  return formatInTimeZone(date, CLUB_TZ, "EEE MMM d, h:mm a")
}

/** Calendar arithmetic on a YYYY-MM-DD date (no time zone involved) */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Midnight at the start of a Central date, as an instant */
export function startOfCentralDay(date: string): Date {
  return fromZonedTime(`${date}T00:00:00`, CLUB_TZ)
}

/** The last millisecond of a Central date */
export function endOfCentralDay(date: string): Date {
  return new Date(startOfCentralDay(addDays(date, 1)).getTime() - 1)
}

/** Monday of the week a Central date falls in */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number)
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7))
}

export type Period = "day" | "week" | "month"

/** The bucket an instant falls in, by Central date: "2026-10-19" (day), "2026-10-19" (the week's Monday), "2026-10" (month) */
export function periodKey(date: Date, by: Period): string {
  const day = centralDate(date)
  if (by === "month") return day.slice(0, 7)
  if (by === "week") return weekStart(day)
  return day
}

/** Every bucket from one Central date to another, so empty periods show as zero */
export function periodsBetween(from: string, to: string, by: Period): string[] {
  const keys: string[] = []
  if (by === "month") {
    let [y, m] = from.split("-").map(Number)
    const [ty, tm] = to.split("-").map(Number)
    while (y < ty || (y === ty && m <= tm)) {
      keys.push(`${y}-${String(m).padStart(2, "0")}`)
      m += 1
      if (m > 12) {
        m = 1
        y += 1
      }
    }
    return keys
  }
  const step = by === "week" ? 7 : 1
  for (let day = by === "week" ? weekStart(from) : from; day <= to; day = addDays(day, step)) keys.push(day)
  return keys
}

/**
 * A Central date range from optional inputs, with defaults relative to today. Errors read well to
 * the model.
 */
export function centralRange(
  input: { from?: string; to?: string },
  defaults: { fromDaysAgo: number; toDaysAhead: number },
  now = new Date(),
): { ok: true; from: string; to: string; start: Date; end: Date } | { ok: false; error: string } {
  const today = centralDate(now)
  const from = input.from ?? addDays(today, -defaults.fromDaysAgo)
  const to = input.to ?? addDays(today, defaults.toDaysAhead)
  if (from > to) return { ok: false, error: `The range starts (${from}) after it ends (${to}).` }
  return { ok: true, from, to, start: startOfCentralDay(from), end: endOfCentralDay(to) }
}

export const dollars = (cents: number) => Math.round(cents) / 100
