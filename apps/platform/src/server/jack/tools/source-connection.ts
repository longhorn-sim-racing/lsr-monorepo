import type { AnyConnector } from "@/server/connectors/types"
import { ct } from "./time"

/**
 * How a tool that reads a synced source (Stripe, email delivery, site traffic, Twitch, Instagram
 * insights, Discord) talks about its connection, so every one says the same things the same way.
 * Connector status never goes in the prompt (design §8), only in tool results. A source that isn't
 * connected and has no data says "not connected"; one switched off or failing after it synced still
 * answers from what it has, saying how old that is. A source that's never read while it's off (Discord)
 * says so instead.
 */
export type SourceConnection = {
  /** Switched on and set up (failing or not): its stored data is current as of its last sync */
  connected: boolean
  /** Its last sync failed (connected, but the data may be behind) */
  failing: boolean
  /** One line for the model, e.g. "Twitch is switched off on System → Connections; what's stored was last synced Mon 2026-10-19 05:00 CT." */
  note: string | null
}

export async function sourceConnection(connector: AnyConnector, label: string): Promise<SourceConnection> {
  const status = await connector.status()
  const synced = status.lastSyncAt ? `last synced ${ct(new Date(status.lastSyncAt))}` : "never synced"
  if (status.state === "connected") return { connected: true, failing: false, note: status.lastSyncAt ? `${label}: connected, ${synced}.` : `${label}: connected, waiting for its first sync.` }
  if (status.state === "error") return { connected: true, failing: true, note: `${label}: its last sync failed (System → Connections has why); ${synced}.` }
  const why = status.state === "off" ? "switched off on System → Connections" : `not set up (missing: ${[...status.missingEnv, ...status.missingSettings].join(", ")})`
  return { connected: false, failing: false, note: `${label} is ${why}; ${status.lastSyncAt ? `what's stored was ${synced}` : "it never synced"}.` }
}

/** The answer when a source isn't connected and nothing was ever synced */
export function notConnected(connection: SourceConnection, what: string) {
  return {
    forModel: `${connection.note} There's no ${what} to read. Say it isn't connected yet; an admin connects it on System → Connections.`,
    label: `${what[0].toUpperCase()}${what.slice(1)}: not connected`,
    displays: [{ kind: "note" as const, text: `${what[0].toUpperCase()}${what.slice(1)} isn't connected yet.` }],
  }
}

/**
 * The answer from a source that's never read while it isn't connected, whatever it stored before
 * (Discord: switching it off is how an admin stops Jack seeing it)
 */
export function notReadWhileOff(connection: SourceConnection, label: string) {
  return {
    forModel: `${connection.note} Nothing from ${label} is read while it isn't connected. Say it isn't connected; an admin connects it on System → Connections.`,
    label: `${label} isn't connected`,
    displays: [{ kind: "note" as const, text: `${label} isn't connected.` }],
  }
}
