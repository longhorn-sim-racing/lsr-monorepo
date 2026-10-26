import { formatInTimeZone, fromZonedTime } from "date-fns-tz"
import { z } from "zod"
import { DEFAULT_TIMEZONE, zoneLabel } from "@/lib/dates"
import { revalidatePaths } from "@/server/cache/revalidate-public"

/** Helpers the changes track's proposal kinds share (event, news, notification, results, check-in and import proposals) */

/** "2026-10-19T18:00", as officers and the admin forms write times */
export const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

export const localTimeInput = (zone: string) => z.string().trim().regex(LOCAL_TIME, `Use local time like 2026-10-19T18:00 (${zone})`)

/** A local time read in a time zone, or null when it isn't a real time */
export function fromLocal(value: string, timeZone: string): Date | null {
  if (!LOCAL_TIME.test(value)) return null
  const date = fromZonedTime(value, timeZone)
  if (Number.isNaN(date.getTime())) return null
  // fromZonedTime rolls 2026-02-30 into March; a time that doesn't read back the same isn't on the calendar
  return formatInTimeZone(date, timeZone, "yyyy-MM-dd'T'HH:mm") === value ? date : null
}

/** "Mon Oct 19, 6:00 PM CT" in the event's (or the club's) time zone */
export function when(date: Date, timeZone = DEFAULT_TIMEZONE): string {
  return `${formatInTimeZone(date, timeZone, "EEE MMM d, h:mm a")} ${zoneLabel(date, timeZone)}`.trim()
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`
}

/** "a", "a and b", "a, b and c" */
export function listed(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Refreshes the pages a change touched, as the admin action does (the services return the paths).
 * Apply runs inside the Apply server action; outside a Next request (scripts, the DB checks) there's
 * nothing to refresh and revalidatePath throws, so that's ignored
 */
export function revalidate(paths: readonly string[]): void {
  try {
    revalidatePaths([...new Set(paths)])
  } catch {}
}

/** Runs `work` over `items` with at most `limit` at a time, keeping their order */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i], i)
    }
  })
  await Promise.all(lanes)
  return out
}

/** A site path a link may point at: plain path characters, never //host or a backslash */
const SITE_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~%/?=&#+:@!$,;]*$/

/**
 * A link for a message or a post: a page of this site (/events/…) or an https link. Null when it's
 * neither, with nothing that could break out of an attribute (quotes, spaces, angle brackets)
 */
export function safeLink(value: string): { url: string; host: string | null } | null {
  const url = value.trim()
  if (SITE_PATH.test(url)) return { url, host: null }
  if (/["'<>\s\\`]/.test(url)) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return null
    return { url: parsed.href, host: parsed.hostname.replace(/^www\./, "") }
  } catch {
    return null
  }
}
