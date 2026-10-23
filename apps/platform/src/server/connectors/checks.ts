import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import type { DigestCheck } from "@/server/automation/types"
import { prisma } from "@/server/db"

/**
 * Connections' "needs attention" check (design §11.2: failing connectors), for the digest and the
 * Overview: a switched-on connection whose last error is newer than its last sync, the rule the
 * Connections page uses for "Failing". Items name the service and link to Connections, never the error
 * text, which can quote the service.
 */

/** Connections whose track has its own check that says more (it would only repeat them) */
export const CONNECTORS_WITH_OWN_CHECK = new Set([
  "google-drive", // documents.drive-folder, documents.sync-failing
  "sharepoint",
  "teams",
  "twitch", // twitch.attention
  "instagram-insights", // instagram-insights.failing
])

const when = (date: Date) => `Since ${formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, h:mm a")} CT`

export const failingConnectors: DigestCheck = {
  id: "connectors.failing",
  label: "Connections failing",
  href: "/admin/connections",
  order: 94,
  async run() {
    // Loaded when it runs: the connector registry pulls in every service's code, which the digest's
    // other users (the Overview, the checks' tests) don't need until this runs
    const { CONNECTORS } = await import("./registry")
    const labels = new Map(CONNECTORS.filter((c) => !CONNECTORS_WITH_OWN_CHECK.has(c.id)).map((c) => [c.id, c.label]))
    if (!labels.size) return { count: 0, severity: "info", items: [] }
    const rows = await prisma.connectorState.findMany({
      where: { id: { in: [...labels.keys()] }, enabled: true, lastErrorAt: { not: null } },
      select: { id: true, lastSyncAt: true, lastErrorAt: true },
    })
    const failing = rows
      .filter((row): row is typeof row & { lastErrorAt: Date } => row.lastErrorAt !== null && (!row.lastSyncAt || row.lastErrorAt >= row.lastSyncAt))
      .sort((a, b) => a.lastErrorAt.getTime() - b.lastErrorAt.getTime())
    return {
      count: failing.length,
      severity: failing.length ? "warning" : "info",
      items: failing.map((row) => ({ title: `${labels.get(row.id)} is failing`, href: "/admin/connections", detail: when(row.lastErrorAt) })),
    }
  },
}
