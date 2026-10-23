import type { JobContext, JobResult } from "@/server/scheduler/types"
import { readConnectorState, recordConnectorError, recordConnectorSync } from "../state"
import { TEAMS_CONNECTOR_ID, teamsConnector } from "./connector"
import { prismaSubscriptionStore, prismaTeamsStore } from "./store"
import { ensureSubscriptions, webhookUrls } from "./subscriptions"
import { syncTeams, type TeamsCursor } from "./sync"

/** The Teams jobs: the daily reconcile (`teams.sync`) and the subscription upkeep (`teams.subscriptions`). Both skip while Teams is off or not set up */

const NOT_CONNECTED: JobResult = { status: "skipped", summary: "Microsoft Teams isn't connected (set it up and switch it on in Connections)." }
/** Time kept back at the end of a sync run for the cursor's save */
const FINISH_MARGIN_MS = 15_000

export async function runTeamsSyncJob({ signal, deadline, log }: Pick<JobContext, "signal" | "deadline" | "log">): Promise<JobResult> {
  const connection = await teamsConnector.client()
  if (!connection) return NOT_CONNECTED
  try {
    const state = await readConnectorState(TEAMS_CONNECTOR_ID)
    const result = await syncTeams({
      graph: connection.graph,
      teamId: connection.teamId,
      channelIds: connection.channelIds,
      store: prismaTeamsStore(),
      cursor: state?.cursor as TeamsCursor | null,
      signal,
      deadline: deadline - FINISH_MARGIN_MS,
      saveCursor: (cursor) => recordConnectorSync(TEAMS_CONNECTOR_ID, { cursor }),
      log,
    })
    await recordConnectorSync(TEAMS_CONNECTOR_ID, { cursor: result.cursor })
    const { channels, messages, deleted, droppedChannels } = result.counts
    const parts = [
      `${channels} ${channels === 1 ? "channel" : "channels"}`,
      `${messages} ${messages === 1 ? "message" : "messages"} saved`,
      deleted ? `${deleted} deleted` : "",
      droppedChannels ? `${droppedChannels} no longer synced` : "",
      result.more ? "more to do next run" : "",
    ].filter(Boolean)
    return { summary: parts.join(", "), counts: { ...result.counts } }
  } catch (error) {
    await recordConnectorError(TEAMS_CONNECTOR_ID, error)
    throw error
  }
}

export async function runTeamsSubscriptionsJob({ signal }: Pick<JobContext, "signal">): Promise<JobResult> {
  const connection = await teamsConnector.client()
  if (!connection) return NOT_CONNECTED
  try {
    const { notificationUrl, lifecycleUrl } = webhookUrls()
    const counts = await ensureSubscriptions({ graph: connection.graph, teamId: connection.teamId, channelIds: connection.channelIds, clientState: connection.clientState, store: prismaSubscriptionStore(), notificationUrl, lifecycleUrl, signal })
    const parts = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([what, n]) => `${n} ${what}`)
    return { summary: parts.length ? `Subscriptions: ${parts.join(", ")}` : "No channels to subscribe to", counts: { ...counts } }
  } catch (error) {
    await recordConnectorError(TEAMS_CONNECTOR_ID, error)
    throw error
  }
}
