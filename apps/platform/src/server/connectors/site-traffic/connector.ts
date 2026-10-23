import { prisma } from "@/server/db"
import { defineConnector } from "../define"
import { siteTrafficClient, utcDay, type SiteTrafficClient } from "./client"

/**
 * Site traffic from Vercel Web Analytics (design §12.5): only the daily snapshot job calls Vercel; the
 * Overview card and Jack's site_traffic tool read the snapshots. The token is project-scoped and can
 * write too (Vercel has no read-only token), so the client is fenced to two GET paths.
 */
export const siteTrafficConnector = defineConnector<SiteTrafficClient>({
  id: "site-traffic",
  label: "Site traffic (Vercel Web Analytics)",
  requiredEnv: ["VERCEL_ANALYTICS_TOKEN", "VERCEL_ANALYTICS_PROJECT_ID"],
  createClient: (env) => siteTrafficClient(env.VERCEL_ANALYTICS_TOKEN!, env.VERCEL_ANALYTICS_PROJECT_ID!, env),
  // Works while switched off: the same queries the snapshot makes, for yesterday (UTC)
  async smoke({ signal } = {}) {
    const client = siteTrafficClient(process.env.VERCEL_ANALYTICS_TOKEN ?? "", process.env.VERCEL_ANALYTICS_PROJECT_ID ?? "")
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const range = utcDay(yesterday)
    const [total, pages] = await Promise.all([client.count(range, signal), client.top("path", range, 5, signal)])
    return { ok: true, summary: `Read ${yesterday} (UTC): ${total.pageviews} page views across ${pages.length} top pages` }
  },
  async details() {
    const [first, last] = await Promise.all([
      prisma.siteTrafficDaily.findFirst({ where: { dimension: "total" }, orderBy: { date: "asc" }, select: { date: true } }),
      prisma.siteTrafficDaily.findFirst({ where: { dimension: "total" }, orderBy: { date: "desc" }, select: { date: true } }),
    ])
    return first && last ? [{ label: "Snapshots", value: `${first.date.toISOString().slice(0, 10)} to ${last.date.toISOString().slice(0, 10)} (UTC days)` }] : []
  },
})
