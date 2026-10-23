import { teamsText } from "./html"
import type { TeamsMessageRow } from "./store"

/** Graph's chatMessage, the parts the sync reads (research/microsoft-graph.md §3e) */
export type GraphChatMessage = {
  id: string
  replyToId?: string | null
  messageType?: string
  createdDateTime?: string
  lastModifiedDateTime?: string
  lastEditedDateTime?: string | null
  deletedDateTime?: string | null
  from?: { user?: { id?: string; displayName?: string } | null; application?: { id?: string; displayName?: string } | null } | null
  body?: { contentType?: string; content?: string } | null
  replies?: GraphChatMessage[]
  "replies@odata.nextLink"?: string
  /** Delta's mark for a message that's gone */
  "@removed"?: { reason?: string }
}

const date = (value: string | null | undefined) => {
  const at = value ? Date.parse(value) : NaN
  return Number.isFinite(at) ? new Date(at) : null
}

/**
 * A chatMessage as a TeamsMessage row, or null for what isn't a message someone wrote (system events
 * like "added to the team", and kinds Graph adds later). A deleted message keeps only who wrote it and
 * when: its text is never stored.
 */
export function toTeamsMessage(message: GraphChatMessage, channelId: string, rootId: string | null = message.replyToId ?? null): TeamsMessageRow | null {
  const deletedAt = date(message.deletedDateTime) ?? (message["@removed"] ? new Date() : null)
  if (!deletedAt && message.messageType && message.messageType !== "message") return null
  const user = message.from?.user
  const app = message.from?.application
  return {
    id: message.id,
    channelId,
    replyToId: rootId && rootId !== message.id ? rootId : null,
    authorAadId: user?.id ?? null,
    authorName: (user?.displayName ?? app?.displayName ?? "Someone").slice(0, 200),
    content: deletedAt ? "" : teamsText(message.body?.content, message.body?.contentType ?? "html"),
    createdAt: date(message.createdDateTime) ?? date(message.lastModifiedDateTime) ?? new Date(),
    editedAt: date(message.lastEditedDateTime),
    deletedAt,
  }
}

export type MessageResource = { teamId: string; channelId: string; messageId: string; replyId?: string }

/**
 * Where a change notification points: "teams('T')/channels('C')/messages('M')" (plus "/replies('R')"
 * for a reply), or the same as slash-separated path segments. Null for anything else.
 */
export function parseMessageResource(resource: string | undefined): MessageResource | null {
  if (!resource) return null
  const quoted = /^\/?teams\('([^']+)'\)\/channels\('([^']+)'\)\/messages\('([^']+)'\)(?:\/replies\('([^']+)'\))?$/i.exec(resource)
  const slashed = /^\/?teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)(?:\/replies\/([^/]+))?$/i.exec(resource)
  const match = quoted ?? slashed
  if (!match) return null
  const decode = (part: string) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  }
  return { teamId: decode(match[1]), channelId: decode(match[2]), messageId: decode(match[3]), ...(match[4] ? { replyId: decode(match[4]) } : {}) }
}

/** The channel ids in MS_CHANNEL_IDS (comma-separated), each like "19:…@thread.tacv2"; anything else is left out */
export function channelIdsFromEnv(value: string | undefined): string[] {
  const ids = (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^19:[^\s,/?#']+$/.test(id))
  return [...new Set(ids)]
}

/** The Graph path of a channel's messages, for requests */
export function messagesPath(teamId: string, channelId: string): string {
  return `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`
}

/** A subscription's resource for a channel's messages, ids as Graph writes them (not URL-encoded) */
export function subscriptionResource(teamId: string, channelId: string): string {
  return `/teams/${teamId}/channels/${channelId}/messages`
}
