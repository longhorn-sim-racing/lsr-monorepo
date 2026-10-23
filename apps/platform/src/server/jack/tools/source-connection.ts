import type { AnyConnector } from "@/server/connectors/types"
import { ct } from "./time"

/**
 * How a tool that reads a synced source (Stripe, email delivery, site traffic) talks about its
 * connection. Connector status never goes in the prompt (design §8), only in tool results. A source
 * that isn't connected and has no data says "not connected"; one switched off or failing after it
 * synced still answers from what it has, saying how old that is.
 */
export type SourceConnection = {
  connected: boolean
  /** One line for the model, e.g. "Switched off by an admin; showing data synced up to Mon 2026-10-19 05:00 CT" */
  note: string | null
}

export async function sourceConnection(connector: AnyConnector, label: string): Promise<SourceConnection> {
  const status = await connector.status()
  const synced = status.lastSyncAt ? `last synced ${ct(new Date(status.lastSyncAt))}` : "never synced"
  if (status.state === "connected") return { connected: true, note: status.lastSyncAt ? `${label}: connected, ${synced}.` : `${label}: connected, waiting for its first sync.` }
  if (status.state === "error") return { connected: true, note: `${label}: its last sync failed (System → Connections has why); ${synced}.` }
  const why = status.state === "off" ? "switched off on System → Connections" : `not set up (missing: ${[...status.missingEnv, ...status.missingSettings].join(", ")})`
  return { connected: false, note: `${label} is ${why}; ${status.lastSyncAt ? `what's stored was ${synced}` : "it never synced"}.` }
}

/** The answer when a source isn't connected and nothing was ever synced */
export function notConnected(connection: SourceConnection, what: string) {
  return {
    forModel: `${connection.note} There's no ${what} to read. Say it isn't connected yet; an admin connects it on System → Connections.`,
    label: `${what[0].toUpperCase()}${what.slice(1)}: not connected`,
    displays: [{ kind: "note" as const, text: `${what[0].toUpperCase()}${what.slice(1)} isn't connected yet.` }],
  }
}
