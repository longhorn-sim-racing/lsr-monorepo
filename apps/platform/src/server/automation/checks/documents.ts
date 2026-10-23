import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { DRIVE_CONNECTOR_ID, DRIVE_ROOT_MISSING } from "@/server/connectors/google-drive/connector"
import { SHAREPOINT_CONNECTOR_ID } from "@/server/connectors/sharepoint/connector"
import { TEAMS_CONNECTOR_ID } from "@/server/connectors/teams/connector"
import { prisma } from "@/server/db"
import type { DigestCheck } from "../types"

/**
 * Digest and Overview "needs attention" checks from the documents track (design §11.2): the shared
 * Drive folder gone (nothing new can be read, and Jack's copy shrinks as the feed reports files gone),
 * and Drive, SharePoint or Teams failing to sync. Only switched-on connectors count. Items name the
 * service and link to Connections; they never carry the error text, which can quote the service.
 */

const LABELS: Record<string, string> = { [DRIVE_CONNECTOR_ID]: "Google Drive", [SHAREPOINT_CONNECTOR_ID]: "SharePoint", [TEAMS_CONNECTOR_ID]: "Microsoft Teams" }
const when = (date: Date) => `Since ${formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, h:mm a")} CT`

type Row = { id: string; enabled: boolean; lastSyncAt: Date | null; lastError: string | null; lastErrorAt: Date | null }

/** Switched on, and the last error is newer than the last sync (as the Connections page decides "Failing") */
const failing = (row: Row): row is Row & { lastErrorAt: Date } => row.enabled && Boolean(row.lastErrorAt && (!row.lastSyncAt || row.lastErrorAt >= row.lastSyncAt))
const rootMissing = (row: Row) => row.id === DRIVE_CONNECTOR_ID && Boolean(row.lastError?.startsWith(DRIVE_ROOT_MISSING))

async function rows(): Promise<Row[]> {
  return prisma.connectorState.findMany({
    where: { id: { in: Object.keys(LABELS) } },
    select: { id: true, enabled: true, lastSyncAt: true, lastError: true, lastErrorAt: true },
  })
}

export const CHECKS: DigestCheck[] = [
  {
    id: "documents.drive-folder",
    label: "Google Drive folder missing",
    href: "/admin/connections",
    order: 92,
    async run() {
      const row = (await rows()).find((r) => r.id === DRIVE_CONNECTOR_ID)
      if (!row || !failing(row) || !rootMissing(row)) return { count: 0, severity: "info", items: [] }
      return {
        count: 1,
        severity: "danger",
        items: [{ title: "The shared Drive folder is gone or no longer shared with Jack's service account", href: "/admin/connections", detail: when(row.lastErrorAt) }],
      }
    },
  },
  {
    id: "documents.sync-failing",
    label: "Document and Teams syncs failing",
    href: "/admin/connections",
    order: 93,
    async run() {
      // A missing Drive folder has its own check
      const broken = (await rows()).filter((row) => failing(row) && !rootMissing(row))
      return {
        count: broken.length,
        severity: broken.length ? "warning" : "info",
        items: broken.map((row) => ({ title: `${LABELS[row.id]} isn't syncing`, href: "/admin/connections", detail: when(row.lastErrorAt!) })),
      }
    },
  },
]
