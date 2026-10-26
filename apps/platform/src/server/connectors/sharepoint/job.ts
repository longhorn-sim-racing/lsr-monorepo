import type { JobContext, JobResult } from "@/server/scheduler/types"
import { prismaDocumentStore } from "../documents/store"
import { readConnectorState, recordConnectorError, recordConnectorSync } from "../state"
import { SHAREPOINT_CONNECTOR_ID, SHAREPOINT_SOURCE, sharePointConnector } from "./connector"
import { syncSharePoint, type SharePointCursor } from "./sync"

/** Time kept back at the end of a run for the last file's read and the cursor's save */
const FINISH_MARGIN_MS = 45_000

/** The `sharepoint.sync` job; skipped while SharePoint is switched off or not set up */
export async function runSharePointSyncJob({ signal, deadline, log }: Pick<JobContext, "signal" | "deadline" | "log">): Promise<JobResult> {
  const connection = await sharePointConnector.client()
  if (!connection) return { status: "skipped", summary: "SharePoint isn't connected (set it up and switch it on in Connections)." }
  try {
    const state = await readConnectorState(SHAREPOINT_CONNECTOR_ID)
    const result = await syncSharePoint({
      graph: connection.graph,
      driveId: connection.driveId,
      store: prismaDocumentStore(SHAREPOINT_SOURCE),
      cursor: state?.cursor as SharePointCursor | null,
      signal,
      deadline: deadline - FINISH_MARGIN_MS,
      saveCursor: (cursor) => recordConnectorSync(SHAREPOINT_CONNECTOR_ID, { cursor }),
      log,
    })
    await recordConnectorSync(SHAREPOINT_CONNECTOR_ID, { cursor: result.cursor })
    const { indexed, unchanged, removed } = result.counts
    const parts = [indexed ? `read ${indexed} ${indexed === 1 ? "file" : "files"}` : "", unchanged ? `${unchanged} unchanged` : "", removed ? `removed ${removed}` : "", result.more ? "more to do next run" : ""].filter(Boolean)
    const summary = parts.join(", ") || "nothing new"
    return { summary: summary.charAt(0).toUpperCase() + summary.slice(1), counts: { ...result.counts } }
  } catch (error) {
    await recordConnectorError(SHAREPOINT_CONNECTOR_ID, error)
    throw error
  }
}
