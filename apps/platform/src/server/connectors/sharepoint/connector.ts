import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { prisma } from "@/server/db"
import { defineConnector } from "../define"
import { graphClient, graphCredentialsFromEnv, type GraphClient } from "../microsoft/graph"
import { readConnectorState } from "../state"
import type { ConnectorEnv } from "../types"
import type { SharePointCursor } from "./sync"

/**
 * SharePoint (design §12.8): the club team's document library in UT's tenant, read with Sites.Selected
 * (a read grant on our site only). Off until UT IT approves and an admin switches it on. Private and
 * shared channels keep their files in sites of their own, each needing its own grant; this connector
 * reads the one library MS_SITE_ID / MS_DRIVE_ID names.
 */

export const SHAREPOINT_CONNECTOR_ID = "sharepoint"
export const SHAREPOINT_SOURCE = "sharepoint"
export const SHAREPOINT_ENV = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_SITE_ID", "MS_DRIVE_ID"]

export type SharePointConnection = { graph: GraphClient; siteId: string; driveId: string }

export function sharePointConnection(env: ConnectorEnv = process.env): SharePointConnection {
  const credentials = graphCredentialsFromEnv(env)
  if (!credentials) throw new Error("SharePoint isn't set up: MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET are needed")
  return { graph: graphClient(credentials, { env }), siteId: (env.MS_SITE_ID ?? "").trim(), driveId: (env.MS_DRIVE_ID ?? "").trim() }
}

const when = (iso: string) => `${formatInTimeZone(new Date(iso), DEFAULT_TIMEZONE, "MMM d, h:mm a")} CT`

export const sharePointConnector = defineConnector<SharePointConnection>({
  id: SHAREPOINT_CONNECTOR_ID,
  label: "SharePoint",
  requiredEnv: SHAREPOINT_ENV,
  createClient: (env) => sharePointConnection(env),
  async smoke({ signal } = {}) {
    const { graph, siteId, driveId } = sharePointConnection()
    const site = await graph.get<{ displayName?: string }>(`/sites/${encodeURIComponent(siteId)}?$select=id,displayName`, { signal })
    const drive = await graph.get<{ name?: string }>(`/drives/${encodeURIComponent(driveId)}?$select=id,name`, { signal })
    return { ok: true, summary: `Read the library “${drive.name ?? driveId}” on the site “${site.displayName ?? siteId}”.` }
  },
  async details() {
    const [documents, state] = await Promise.all([prisma.externalDocument.count({ where: { source: SHAREPOINT_SOURCE, deletedAt: null } }), readConnectorState(SHAREPOINT_CONNECTOR_ID)])
    const cursor = (state?.cursor ?? {}) as SharePointCursor
    return [
      { label: "Documents", value: documents.toLocaleString("en-US") },
      ...(cursor.enumeration ? [{ label: "Full enumeration", value: "in progress" }] : []),
      { label: "Last full enumeration", value: cursor.lastFullAt ? when(cursor.lastFullAt) : "not yet" },
    ]
  },
})
