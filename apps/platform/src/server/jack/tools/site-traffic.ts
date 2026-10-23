import { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"
import type { TrafficDimension } from "@/server/connectors/site-traffic/client"
import { siteTrafficConnector } from "@/server/connectors/site-traffic/connector"
import { percentChange, shiftDay, totalsOf, trafficCoverage, trafficDaily, trafficKeyDaily, trafficTop } from "@/server/connectors/site-traffic/read"
import { forModelWithLists, tableDisplay } from "./display"
import { notConnected, sourceConnection } from "./source-connection"
import { isCalendarDate } from "./time"
import type { JackTool } from "./types"

/**
 * site_traffic (#188, design §7.1, §12.5): the public site's page views and visitors, from the daily
 * snapshots of Vercel Web Analytics: by day, or by page, referrer, country or device. Days are UTC
 * (Vercel's), and admin pages aren't counted.
 */

const utcDateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-19")
  .refine(isCalendarDate, { error: (issue) => `${String(issue.input)} isn't a date on the calendar` })

const input = z.object({
  by: z
    .enum(["day", "path", "referrer", "country", "device"])
    .default("day")
    .describe("day: totals day by day. path (pages), referrer (the site that sent people; (direct) when none), country, device: the top groups over the range"),
  from: utcDateInput.optional().describe("First day, UTC (default: 7 days before to)"),
  to: utcDateInput.optional().describe("Last day, UTC (default: the latest snapshot)"),
  match: z.string().trim().max(200).optional().describe("Only groups whose key contains this, e.g. /apply or instagram"),
  daily: z.boolean().default(false).describe("With by path/referrer/country/device and match: each matching group day by day (e.g. how /apply did around a meeting)"),
  compare: z.boolean().default(false).describe("Also total the same number of days just before the range"),
  limit: z.number().int().min(1).max(100).default(20).describe("Most groups or rows to list"),
})

const NOTES = [
  "Days are UTC: each starts at 7 PM Central the evening before (6 PM in winter). Admin pages aren't counted.",
  "Vercel counts a visitor once per day, so visitorDays adds up each day's visitors (someone who came on three days counts three times); visitorsPerDay is the fair figure for a range.",
  "Referrers are partial: apps like Instagram and Discord often send none, which shows as (direct).",
].join(" ")

export const siteTrafficTool: JackTool<z.infer<typeof input>> = {
  name: "site_traffic",
  description:
    "Site traffic for the club's public website (Vercel Web Analytics, snapshotted daily): page views and visitors day by day, or the top pages, referrers (Instagram, Discord, Google and so on), countries and devices (mobile, desktop) over a date range, with an optional comparison to the period before. match with daily shows one page or referrer day by day. Days are UTC; admin pages aren't counted; the snapshots go back to when the sync started (Vercel itself keeps a month).",
  input,
  deferred: true,
  async run({ by, from, to, match, daily, compare, limit }) {
    const connection = await sourceConnection(siteTrafficConnector, "Site traffic")
    const coverage = await trafficCoverage()
    if (!coverage) return connection.connected ? { forModel: `${connection.note} No days are stored yet; the daily snapshot fills them.`, label: "Site traffic: no snapshots yet", displays: [{ kind: "note", text: "No site traffic stored yet." }] } : notConnected(connection, "site traffic")

    const end = to ?? coverage.last
    const start = from ?? shiftDay(end, -6)
    if (start > end) return { isError: true, forModel: `The range starts (${start}) after it ends (${end}).`, label: "Site traffic lookup failed", displays: [] }
    const span = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1
    const base = {
      connection: connection.note,
      range: { from: start, to: end, days: span, timeZone: "UTC" },
      stored: { from: coverage.first, to: coverage.last, days: coverage.days },
      ...(start < coverage.first || end > coverage.last ? { gap: `Only ${coverage.first} to ${coverage.last} is stored; days outside that aren't counted.` } : {}),
      notes: NOTES,
    }

    const days = await trafficDaily(start, end)
    const totals = totalsOf(days)
    let previous: Record<string, unknown> | undefined
    if (compare) {
      const before = totalsOf(await trafficDaily(shiftDay(start, -span), shiftDay(start, -1)))
      previous = {
        range: { from: shiftDay(start, -span), to: shiftDay(start, -1) },
        ...before,
        pageviewsChangePercent: percentChange(totals.pageviews, before.pageviews),
        visitorsPerDayChangePercent: percentChange(totals.visitorsPerDay, before.visitorsPerDay),
      }
    }
    const result = { ...base, totals, ...(previous ? { previous } : {}) }
    const stats: JackToolDisplay = {
      kind: "stats",
      items: [
        { label: "Page views", value: totals.pageviews, hint: `${start} to ${end} (UTC)` },
        { label: "Visitors a day", value: totals.visitorsPerDay, hint: "average" },
        ...(previous && typeof previous.pageviewsChangePercent === "number" ? [{ label: "Change in views", value: `${previous.pageviewsChangePercent > 0 ? "+" : ""}${previous.pageviewsChangePercent}%`, hint: "vs the period before" }] : []),
      ],
    }

    if (by === "day") {
      return {
        forModel: forModelWithLists(result, [{ key: "days", items: days, keep: "last" }]),
        label: `Looked at site traffic (${start} to ${end}: ${totals.pageviews} page views)`,
        displays: [stats, tableDisplay(days, [{ header: "Day (UTC)", value: (d) => d.day }, { header: "Page views", value: (d) => d.pageviews }, { header: "Visitors", value: (d) => d.visitors }])],
      }
    }

    const dimension = by as TrafficDimension
    if (daily && match) {
      const rows = await trafficKeyDaily(dimension, start, end, match, 400)
      return {
        forModel: forModelWithLists({ ...result, by, match }, [{ key: "rows", items: rows, keep: "last", whenTrimmed: "Shorten the range or narrow match." }]),
        label: `Looked at site traffic for "${match}" day by day`,
        displays: [stats, rows.length ? tableDisplay(rows, [{ header: "Day (UTC)", value: (r) => r.day }, { header: by, value: (r) => r.key }, { header: "Page views", value: (r) => r.pageviews }, { header: "Visitors", value: (r) => r.visitors }]) : { kind: "note", text: `Nothing matches "${match}".` }],
      }
    }

    const groups = await trafficTop(dimension, start, end, { match, limit })
    return {
      forModel: forModelWithLists({ ...result, by, ...(match ? { match } : {}), groupsNote: "Each day keeps its top 100 per kind; the rest is in an \"Others\" group." }, [{ key: "groups", items: groups }]),
      label: `Looked at site traffic by ${by} (${start} to ${end})`,
      displays: [stats, groups.length ? tableDisplay(groups, [{ header: by === "path" ? "Page" : by[0].toUpperCase() + by.slice(1), value: (g) => g.key }, { header: "Page views", value: (g) => g.pageviews }, { header: "Visitor-days", value: (g) => g.visitorDays }]) : { kind: "note", text: match ? `Nothing matches "${match}".` : "Nothing stored for that range." }],
    }
  },
}
