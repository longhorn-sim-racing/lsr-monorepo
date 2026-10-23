import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { prisma } from "@/server/db"
import { defineConnector } from "../define"
import { readConnectorState } from "../state"
import type { ConnectorEnv } from "../types"
import { serviceAccountFromEnv } from "./auth"
import { driveClient, DriveApiError, FOLDER_TYPE, type DriveClient } from "./client"
import type { DriveCursor } from "./sync"

/**
 * Google Drive (design §12.7): the club's shared folder, read by a service account with
 * drive.readonly. Off until an admin switches it on in Connections; its sync job keeps
 * ExternalDocument current, and `search`/`read` (club-data) read from there.
 */

export const DRIVE_CONNECTOR_ID = "google-drive"
export const DRIVE_SOURCE = "drive"

/** The start of the error stored when the shared folder is gone; the digest check looks for it */
export const DRIVE_ROOT_MISSING = "Google Drive: the shared folder is gone or no longer shared"

/** Set in env: GOOGLE_DRIVE_SA_KEY_ID is optional (it only becomes the JWT's kid) */
export const DRIVE_ENV = ["GOOGLE_DRIVE_SA_EMAIL", "GOOGLE_DRIVE_SA_PRIVATE_KEY", "GOOGLE_DRIVE_ROOT_FOLDER_ID"]

export type DriveConnection = { drive: DriveClient; rootId: string }

export function driveConnection(env: ConnectorEnv = process.env): DriveConnection {
  const account = serviceAccountFromEnv(env)
  if (!account) throw new Error("Google Drive isn't set up: GOOGLE_DRIVE_SA_EMAIL and GOOGLE_DRIVE_SA_PRIVATE_KEY are needed")
  return { drive: driveClient(account, { env }), rootId: (env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? "").trim() }
}

const when = (iso: string) => `${formatInTimeZone(new Date(iso), DEFAULT_TIMEZONE, "MMM d, h:mm a")} CT`

export const googleDriveConnector = defineConnector<DriveConnection>({
  id: DRIVE_CONNECTOR_ID,
  label: "Google Drive",
  requiredEnv: DRIVE_ENV,
  createClient: (env) => driveConnection(env),
  // Works while switched off: it builds its own client
  async smoke({ signal } = {}) {
    const { drive, rootId } = driveConnection()
    try {
      const root = await drive.getFile(rootId, "id,name,mimeType", signal)
      if (root.mimeType !== FOLDER_TYPE) return { ok: false, summary: "GOOGLE_DRIVE_ROOT_FOLDER_ID names a file, not a folder." }
      const page = await drive.listChildren(rootId, undefined, signal)
      const count = page.files?.length ?? 0
      return { ok: true, summary: `Read the folder “${root.name}”: ${count}${page.nextPageToken ? "+" : ""} ${count === 1 ? "item" : "items"} at its top level.` }
    } catch (error) {
      if (error instanceof DriveApiError && error.status === 404) {
        return { ok: false, summary: "The folder isn't there, or isn't shared with the service account (404). Share it with GOOGLE_DRIVE_SA_EMAIL as Viewer." }
      }
      throw error
    }
  },
  async details() {
    const [documents, state] = await Promise.all([prisma.externalDocument.count({ where: { source: DRIVE_SOURCE, deletedAt: null } }), readConnectorState(DRIVE_CONNECTOR_ID)])
    const cursor = (state?.cursor ?? {}) as DriveCursor
    const lines = [{ label: "Documents", value: documents.toLocaleString("en-US") }]
    if (cursor.walk?.full) lines.push({ label: "Full walk", value: `in progress, ${cursor.walk.queue.length} ${cursor.walk.queue.length === 1 ? "folder" : "folders"} left` })
    lines.push({ label: "Last full walk", value: cursor.lastWalkAt ? when(cursor.lastWalkAt) : "not yet" })
    if (cursor.rootMissingAt) lines.push({ label: "Shared folder", value: `missing since ${when(cursor.rootMissingAt)}` })
    return lines
  },
})
