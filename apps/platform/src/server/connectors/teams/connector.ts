import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { prisma } from "@/server/db"
import { defineConnector } from "../define"
import { graphClient, graphCredentialsFromEnv, type GraphClient } from "../microsoft/graph"
import type { ConnectorEnv } from "../types"
import { channelIdsFromEnv, messagesPath } from "./messages"

/**
 * Microsoft Teams (design §12.8): messages in the officers' channels of the club team, read through
 * a Teams app with the resource-specific permission ChannelMessage.Read.Group that a team owner grants
 * by installing it. Change notifications keep the copy current, with one delta reconcile a day (Microsoft
 * allows polling once a day). Off until UT IT approves and an admin switches it on; while it's off,
 * `search` and `read` don't touch Teams at all, and notifications are dropped.
 */

export const TEAMS_CONNECTOR_ID = "teams"
export const TEAMS_ENV = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_TEAM_ID", "MS_CHANNEL_IDS", "MS_GRAPH_CLIENT_STATE"]

export type TeamsConnection = { graph: GraphClient; teamId: string; channelIds: string[]; clientState: string }

export function teamsConnection(env: ConnectorEnv = process.env): TeamsConnection {
  const credentials = graphCredentialsFromEnv(env)
  if (!credentials) throw new Error("Teams isn't set up: MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET are needed")
  return { graph: graphClient(credentials, { env }), teamId: (env.MS_TEAM_ID ?? "").trim(), channelIds: channelIdsFromEnv(env.MS_CHANNEL_IDS), clientState: (env.MS_GRAPH_CLIENT_STATE ?? "").trim() }
}

const when = (date: Date) => `${formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, h:mm a")} CT`

export const teamsConnector = defineConnector<TeamsConnection>({
  id: TEAMS_CONNECTOR_ID,
  label: "Microsoft Teams",
  requiredEnv: TEAMS_ENV,
  createClient: (env) => teamsConnection(env),
  async smoke({ signal } = {}) {
    const { graph, teamId, channelIds } = teamsConnection()
    if (!channelIds.length) return { ok: false, summary: "MS_CHANNEL_IDS has no channel ids (they look like 19:…@thread.tacv2)." }
    const [first] = channelIds
    const page = await graph.page(`${messagesPath(teamId, first)}?$top=1`, { signal })
    return { ok: true, summary: `Read ${page.value.length ? "the latest message" : "no messages yet"} in the first of ${channelIds.length} configured ${channelIds.length === 1 ? "channel" : "channels"}.` }
  },
  async details() {
    const configured = channelIdsFromEnv(process.env.MS_CHANNEL_IDS)
    const [channels, messages, subscriptions] = await Promise.all([
      prisma.teamsChannel.findMany({ where: { synced: true }, select: { name: true }, orderBy: { name: "asc" } }),
      prisma.teamsMessage.count({ where: { deletedAt: null } }),
      prisma.graphSubscription.findMany({ select: { expiresAt: true }, orderBy: { expiresAt: "asc" } }),
    ])
    const raw = (process.env.MS_CHANNEL_IDS ?? "").split(",").filter((id) => id.trim()).length
    return [
      { label: "Channels", value: channels.length ? channels.map((c) => `#${c.name}`).join(", ") : `${configured.length} configured, none synced yet` },
      ...(raw > configured.length ? [{ label: "MS_CHANNEL_IDS", value: `${raw - configured.length} ${raw - configured.length === 1 ? "entry isn't" : "entries aren't"} a channel id (19:…), left out` }] : []),
      { label: "Messages", value: messages.toLocaleString("en-US") },
      { label: "Change notifications", value: subscriptions.length ? `${subscriptions.length} active, next renewal by ${when(subscriptions[0].expiresAt)}` : "none yet" },
    ]
  },
})
