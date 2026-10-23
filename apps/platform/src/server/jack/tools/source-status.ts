import type { AnyConnector } from "@/server/connectors/types"
import { ct } from "./time"

/**
 * Whether a synced source is connected, for a tool result (design §8: connector status goes in tool
 * results, never the prompt). The tools still answer from what's stored, and say how fresh it is.
 */
export type SourceStatus = { connected: boolean; lastSync: string | null; note?: string }

export async function sourceStatus(connector: AnyConnector): Promise<SourceStatus> {
  const status = await connector.status()
  const lastSync = status.lastSyncAt ? ct(new Date(status.lastSyncAt)) : null
  const since = lastSync ? `, so the stored numbers stop at its last sync (${lastSync})` : ", and nothing has been synced yet"
  if (status.state === "connected") return { connected: true, lastSync }
  if (status.state === "error") return { connected: true, lastSync, note: `${connector.label}'s last sync failed (${status.lastErrorAt ? ct(new Date(status.lastErrorAt)) : "recently"}), so the numbers may be behind. Officers see the error on System → Connections.` }
  if (status.state === "off") return { connected: false, lastSync, note: `${connector.label} isn't connected: it's switched off on System → Connections${since}.` }
  return { connected: false, lastSync, note: `${connector.label} isn't connected yet (set up on System → Connections)${since}.` }
}
