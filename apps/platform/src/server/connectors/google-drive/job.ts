import type { JobContext, JobResult } from "@/server/scheduler/types"
import { prismaDocumentStore } from "../documents/store"
import { readConnectorState, recordConnectorError, recordConnectorSync } from "../state"
import { DRIVE_CONNECTOR_ID, DRIVE_ROOT_MISSING, DRIVE_SOURCE, googleDriveConnector } from "./connector"
import { syncDrive, type DriveCursor, type DriveSyncResult } from "./sync"

/**
 * The `google-drive.sync` job: one run of syncDrive with the connector's client, its cursor saved to
 * ConnectorState as it goes. Skipped while Drive is switched off or not set up. A missing root folder
 * fails the run and is recorded as the connector's error (Connections shows it, and the digest check
 * `documents.drive-folder` flags it).
 */

export { DRIVE_ROOT_MISSING }

/** Time kept back at the end of a run: the last file's read (up to 25 s for a big PDF) and the cursor's save */
const FINISH_MARGIN_MS = 45_000

export function driveSummary({ counts, cursor, more }: Pick<DriveSyncResult, "counts" | "cursor" | "more">): string {
  const parts = [
    counts.indexed ? `read ${counts.indexed} ${counts.indexed === 1 ? "file" : "files"}` : "",
    counts.unchanged ? `${counts.unchanged} unchanged` : "",
    counts.removed ? `removed ${counts.removed}` : "",
    counts.changes ? `${counts.changes} ${counts.changes === 1 ? "change" : "changes"} from the feed` : "",
  ].filter(Boolean)
  const walk = cursor.walk ? `${cursor.walk.full ? "full walk" : "folder walk"} in progress, ${cursor.walk.queue.length} ${cursor.walk.queue.length === 1 ? "folder" : "folders"} left` : ""
  const text = [parts.join(", ") || "Nothing new", walk, more && !walk ? "more to do next run" : ""].filter(Boolean).join("; ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export async function runDriveSyncJob({ signal, deadline, log }: Pick<JobContext, "signal" | "deadline" | "log">): Promise<JobResult> {
  const connection = await googleDriveConnector.client()
  if (!connection) return { status: "skipped", summary: "Google Drive isn't connected (set it up and switch it on in Connections)." }
  try {
    const state = await readConnectorState(DRIVE_CONNECTOR_ID)
    const result = await syncDrive({
      client: connection.drive,
      rootId: connection.rootId,
      store: prismaDocumentStore(DRIVE_SOURCE),
      cursor: state?.cursor as DriveCursor | null,
      signal,
      deadline: deadline - FINISH_MARGIN_MS,
      saveCursor: (cursor) => recordConnectorSync(DRIVE_CONNECTOR_ID, { cursor }),
      log,
    })
    await recordConnectorSync(DRIVE_CONNECTOR_ID, { cursor: result.cursor })
    if (result.rootMissing) {
      throw new Error(`${DRIVE_ROOT_MISSING} (404). Ask its owner to share it with the service account (the key's client_email) as Viewer again, or fix GOOGLE_DRIVE_FOLDER_ID.`)
    }
    return { summary: driveSummary(result), counts: { ...result.counts } }
  } catch (error) {
    await recordConnectorError(DRIVE_CONNECTOR_ID, error)
    throw error
  }
}
