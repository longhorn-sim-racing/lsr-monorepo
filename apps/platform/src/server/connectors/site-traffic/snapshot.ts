import { prisma } from "@/server/db"
import { SiteTrafficApiError, TRAFFIC_DIMENSIONS, utcDay, type SiteTrafficClient, type TrafficDimension } from "./client"

/**
 * The daily site traffic snapshot (design §12.5). Vercel keeps a month of Web Analytics on Hobby, so
 * each run stores every complete UTC day of that month that isn't stored yet (the first run backfills
 * the whole month): the day's page views and visitors, and its top 100 pages, referrers, countries and
 * devices. A day's rows are replaced together, so a rerun changes nothing. Days are Vercel's UTC days,
 * not Chicago dates (the schema notes say so).
 */

const DAY_MS = 86_400_000

/** How many days back a run reaches: inside Hobby's one-month window with a day to spare */
export const SNAPSHOT_WINDOW_DAYS = 29
/** Groups kept per dimension per day (Vercel folds the rest into "Others") */
export const TOP_LIMIT = 100
/** Days fetched at once (five calls each) */
const PARALLEL_DAYS = 2

const DIMENSIONS = Object.keys(TRAFFIC_DIMENSIONS) as TrafficDimension[]

/** "2026-10-21" for a UTC day */
const isoDay = (date: Date) => date.toISOString().slice(0, 10)

/** The complete UTC days in the window, oldest first (they leave Vercel's window soonest) */
export function windowDays(now: Date, days = SNAPSHOT_WINDOW_DAYS): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Array.from({ length: days }, (_, i) => isoDay(new Date(today - (days - i) * DAY_MS)))
}

export type SnapshotResult = { summary: string; counts: { days: number; rows: number; skipped: number }; more: boolean }

/** Fetches and stores one UTC day: its total and each dimension's top groups. Returns the rows written */
async function snapshotDay(client: SiteTrafficClient, day: string, signal?: AbortSignal): Promise<number> {
  const range = utcDay(day)
  const [total, ...tops] = await Promise.all([client.count(range, signal), ...DIMENSIONS.map((dimension) => client.top(dimension, range, TOP_LIMIT, signal))])
  const date = new Date(`${day}T00:00:00.000Z`)
  const rows = [
    { date, dimension: "total", key: "all", pageviews: total.pageviews, visitors: total.visitors },
    ...DIMENSIONS.flatMap((dimension, i) => tops[i].map((row) => ({ date, dimension, key: row.key, pageviews: row.pageviews, visitors: row.visitors }))),
  ]
  await prisma.$transaction([prisma.siteTrafficDaily.deleteMany({ where: { date } }), prisma.siteTrafficDaily.createMany({ data: rows })])
  return rows.length
}

export async function snapshotSiteTraffic(client: SiteTrafficClient, options: { now?: Date; signal?: AbortSignal; log?: (line: string) => void } = {}): Promise<SnapshotResult> {
  const now = options.now ?? new Date()
  const window = windowDays(now)
  const stored = await prisma.siteTrafficDaily.findMany({ where: { dimension: "total", date: { gte: new Date(`${window[0]}T00:00:00.000Z`) } }, select: { date: true } })
  const have = new Set(stored.map((row) => isoDay(row.date)))
  const todo = window.filter((day) => !have.has(day))

  let days = 0
  let rows = 0
  let skipped = 0
  let more = false
  for (let i = 0; i < todo.length; i += PARALLEL_DAYS) {
    if (options.signal?.aborted) {
      more = true
      break
    }
    const batch = todo.slice(i, i + PARALLEL_DAYS)
    const results = await Promise.allSettled(batch.map((day) => snapshotDay(client, day, options.signal)))
    for (const [j, result] of results.entries()) {
      if (result.status === "fulfilled") {
        days += 1
        rows += result.value
        continue
      }
      const error = result.reason
      if (options.signal?.aborted) {
        more = true
        continue
      }
      // A day Vercel no longer has (outside the plan's window) is skipped; anything else stops the run
      if (error instanceof SiteTrafficApiError && error.status === 402) {
        skipped += 1
        options.log?.(`Skipped ${batch[j]}: outside the plan's reporting window`)
        continue
      }
      if (error instanceof SiteTrafficApiError && error.status === 429) {
        more = true
        options.log?.("Vercel rate limited the run; the next one continues")
        break
      }
      throw error
    }
    if (more) break
  }

  const summary = !todo.length
    ? `Every day from ${window[0]} to ${window[window.length - 1]} (UTC) was already stored`
    : `Stored ${days} of ${todo.length} missing ${todo.length === 1 ? "day" : "days"} (UTC, ${todo[0]} to ${todo[todo.length - 1]}), ${rows} rows${skipped ? `; ${skipped} outside Vercel's window` : ""}${more ? ". The next run continues" : ""}`
  return { summary, counts: { days, rows, skipped }, more }
}
