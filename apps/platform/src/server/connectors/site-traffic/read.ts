import { prisma } from "@/server/db"
import type { TrafficDimension } from "./client"

/**
 * Reads the site traffic snapshots (SiteTrafficDaily) for the Overview card and Jack's site_traffic
 * tool. Days are UTC. Vercel counts a visitor once per day, so visitors added up over several days are
 * "visitor-days" (someone who came on three days counts three times); the honest figure for a range is
 * the average a day.
 */

const DAY_MS = 86_400_000

/** "2026-10-21" plus or minus whole days */
export const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)

const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`)
const isoDay = (date: Date) => date.toISOString().slice(0, 10)

export type DailyTraffic = { day: string; pageviews: number; visitors: number }

export type TrafficTotals = {
  /** Days with a snapshot in the range */
  days: number
  pageviews: number
  /** Visitors added up day by day (a returning visitor counts once per day) */
  visitorDays: number
  /** visitorDays over days, rounded */
  visitorsPerDay: number
}

export function totalsOf(daily: DailyTraffic[]): TrafficTotals {
  const pageviews = daily.reduce((n, d) => n + d.pageviews, 0)
  const visitorDays = daily.reduce((n, d) => n + d.visitors, 0)
  return { days: daily.length, pageviews, visitorDays, visitorsPerDay: daily.length ? Math.round(visitorDays / daily.length) : 0 }
}

/** The change from `previous` to `current` in percent (one decimal), or null when there's nothing to compare */
export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

/** The first and last stored day, and how many days are stored */
export async function trafficCoverage(): Promise<{ first: string; last: string; days: number } | null> {
  const agg = await prisma.siteTrafficDaily.aggregate({ where: { dimension: "total" }, _min: { date: true }, _max: { date: true }, _count: true })
  if (!agg._min.date || !agg._max.date) return null
  return { first: isoDay(agg._min.date), last: isoDay(agg._max.date), days: agg._count }
}

/** Each stored day's totals in [from, to], oldest first */
export async function trafficDaily(from: string, to: string): Promise<DailyTraffic[]> {
  const rows = await prisma.siteTrafficDaily.findMany({ where: { dimension: "total", date: { gte: asDate(from), lte: asDate(to) } }, orderBy: { date: "asc" }, select: { date: true, pageviews: true, visitors: true } })
  return rows.map((row) => ({ day: isoDay(row.date), pageviews: row.pageviews, visitors: row.visitors }))
}

export type TrafficGroup = { key: string; pageviews: number; visitorDays: number; days: number }

/** One dimension's groups added up over [from, to], most viewed first; `match` keeps keys that contain it */
export async function trafficTop(dimension: TrafficDimension, from: string, to: string, options: { match?: string; limit?: number } = {}): Promise<TrafficGroup[]> {
  const groups = await prisma.siteTrafficDaily.groupBy({
    by: ["key"],
    where: { dimension, date: { gte: asDate(from), lte: asDate(to) }, ...(options.match ? { key: { contains: options.match, mode: "insensitive" as const } } : {}) },
    _sum: { pageviews: true, visitors: true },
    _count: { _all: true },
    orderBy: [{ _sum: { pageviews: "desc" } }, { key: "asc" }],
    take: options.limit ?? 20,
  })
  return groups.map((g) => ({ key: g.key, pageviews: g._sum.pageviews ?? 0, visitorDays: g._sum.visitors ?? 0, days: g._count._all }))
}

/** One dimension's matching keys day by day, for "how did /apply do" */
export async function trafficKeyDaily(dimension: TrafficDimension, from: string, to: string, match: string, limit = 200): Promise<(DailyTraffic & { key: string })[]> {
  const rows = await prisma.siteTrafficDaily.findMany({
    where: { dimension, date: { gte: asDate(from), lte: asDate(to) }, key: { contains: match, mode: "insensitive" } },
    orderBy: [{ date: "asc" }, { pageviews: "desc" }],
    take: limit,
    select: { date: true, key: true, pageviews: true, visitors: true },
  })
  return rows.map((row) => ({ day: isoDay(row.date), key: row.key, pageviews: row.pageviews, visitors: row.visitors }))
}

export type TrafficWeek = {
  from: string
  to: string
  current: TrafficTotals
  /** The 7 days before; null when none of them are stored */
  previous: TrafficTotals | null
  topPages: TrafficGroup[]
}

/** The latest 7 stored days against the 7 before them, and their top pages: the Overview card */
export async function trafficWeek(): Promise<TrafficWeek | null> {
  const coverage = await trafficCoverage()
  if (!coverage) return null
  const to = coverage.last
  const from = shiftDay(to, -6)
  const [current, previous, topPages] = await Promise.all([trafficDaily(from, to), trafficDaily(shiftDay(to, -13), shiftDay(to, -7)), trafficTop("path", from, to, { limit: 5 })])
  return { from, to, current: totalsOf(current), previous: previous.length ? totalsOf(previous) : null, topPages }
}
