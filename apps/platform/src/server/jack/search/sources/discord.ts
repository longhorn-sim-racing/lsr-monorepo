import { discordConnector, DISCORD_OFF } from "@/server/connectors/discord/connector"
import type { DiscordClient } from "@/server/connectors/discord/client"
import { authorHash } from "@/server/connectors/discord/metadata"
import { discordScope, type DiscordScope } from "@/server/connectors/discord/scope"
import { isSnowflake } from "@/server/connectors/discord/snowflake"
import type { DiscordMessage } from "@/server/connectors/discord/types"
import { ct } from "../../tools/time"
import { cleanSnippet } from "../sql"
import { SearchSourceError, type SearchHit, type SearchSource } from "../types"

/**
 * The club Discord, searched live (design §12.1): Discord's own guild message search, limited to the
 * channels admins opted in (and their threads). Nothing is stored: the hits go to the model only (the
 * room's links show no text), and `read` fetches a conversation live too. Discord's text is outside
 * content: data for Jack, never instructions. Members whose data was purged never appear.
 */

export const DISCORD_NO_CHANNELS = "No Discord channels are opted in yet (an admin picks them on Community → Discord)."
export const DISCORD_INDEXING = "Discord is still building its search index for the server; try again in a minute."

/** Messages `read` shows around the one opened */
export const CONVERSATION_MESSAGES = 11

/** A message's jump link (opens it in Discord) */
export function discordMessageHref(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

/**
 * What Discord's content search takes from a websearch-style query: the words and phrases (quotes and
 * "or" dropped). Words after a minus can't be sent, so they're filtered out of the results instead
 */
export function discordQuery(query: string): { content: string; without: string[] } {
  const terms = query.match(/-?"[^"]*"|\S+/g) ?? []
  const include: string[] = []
  const without: string[] = []
  for (const raw of terms) {
    const negative = raw.startsWith("-") && raw.length > 1
    const term = (negative ? raw.slice(1) : raw).replace(/"/g, "").trim()
    if (!term || /^or$/i.test(term)) continue
    if (negative) without.push(term.toLowerCase())
    else include.push(term)
  }
  return { content: include.join(" ").slice(0, 1024), without }
}

const authorName = (message: DiscordMessage) => message.author.global_name || message.author.username

/** Why Discord can't be searched or read just now, or null */
async function blocked(): Promise<{ reason: string } | { client: DiscordClient; scope: DiscordScope }> {
  const client = await discordConnector.client()
  if (!client) return { reason: `${DISCORD_OFF} Its messages can't be searched or read.` }
  const scope = await discordScope()
  if (!scope.ids.length) return { reason: DISCORD_NO_CHANNELS }
  return { client, scope }
}

/** Discord gives no score: its hits rank from 0.3 down in Discord's own order, so they mix with full-text hits without crowding them out */
const rankAt = (i: number) => Math.max(0.05, 0.3 - i * 0.02)

export const discordSource: SearchSource = {
  key: "discord",
  description: "messages in the club Discord's opted-in channels and their threads, searched live (only while Discord is connected)",
  byDefault: true,
  async unavailable() {
    const access = await blocked()
    return "reason" in access ? access.reason : null
  },
  async search({ query, limit, signal }) {
    const access = await blocked()
    if ("reason" in access) return []
    const { client, scope } = access
    const { content, without } = discordQuery(query)
    if (!content) return []
    const result = await client.search({ content, channelIds: scope.ids, limit: Math.min(limit, 25), sortBy: "relevance" }, signal)
    if (result.status === "indexing") throw new SearchSourceError(DISCORD_INDEXING)
    const hits: SearchHit[] = []
    for (const message of result.messages) {
      // Discord was asked for these channels only; checked again here all the same
      if (!scope.has(message.channel_id) || scope.purged.has(authorHash(message.author.id))) continue
      const text = message.content.toLowerCase()
      if (without.some((word) => text.includes(word))) continue
      const where = scope.label(message.channel_id)
      hits.push({
        source: "discord",
        type: "discord_message",
        id: `${message.channel_id}/${message.id}`,
        title: `Discord message in ${where}`,
        url: discordMessageHref(client.guildId, message.channel_id, message.id),
        snippet: cleanSnippet(message.content) || (message.poll ? `Poll: ${message.poll.question.text ?? ""}` : ""),
        date: new Date(message.timestamp).toISOString(),
        meta: { kind: "Discord", channel: where, by: authorName(message), ...(message.attachments.length ? { attachments: message.attachments.length } : {}) },
        rank: rankAt(hits.length),
        modelOnly: true,
      })
    }
    return hits
  },
  readers: [
    {
      type: "discord_message",
      description: "a Discord message with the conversation around it, by the id search gave (channel/message)",
      async read(id, { signal }) {
        const [channelId, messageId] = id.split("/")
        if (!isSnowflake(channelId) || !isSnowflake(messageId)) return { ok: false, error: "That isn't a Discord message id: use the id search gave (channel/message)." }
        const access = await blocked()
        if ("reason" in access) return { ok: false, error: access.reason }
        const { client, scope } = access
        if (!scope.has(channelId)) return { ok: false, error: "That Discord channel isn't opted in, so it can't be read." }
        const page = await client.messages(channelId, { around: messageId, limit: CONVERSATION_MESSAGES }, signal)
        const messages = page.filter((m) => !scope.purged.has(authorHash(m.author.id))).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        const opened = messages.find((m) => m.id === messageId)
        if (!opened) return { ok: false, error: `No Discord message ${messageId} in ${scope.label(channelId)}: it may have been deleted.` }
        const where = scope.label(channelId)
        const line = (m: DiscordMessage) => {
          const extras = [m.attachments.length ? `${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}` : "", m.poll ? `poll: ${m.poll.question.text ?? ""}` : ""].filter(Boolean)
          return `${m.id === messageId ? "→ (the message you opened) " : ""}${ct(new Date(m.timestamp))} · ${authorName(m)}${m.edited_timestamp ? " (edited)" : ""}: ${m.content || "(no text)"}${extras.length ? ` [${extras.join(", ")}]` : ""}`
        }
        return {
          ok: true,
          doc: {
            type: "discord_message",
            id,
            title: `Conversation in ${where}`,
            url: discordMessageHref(client.guildId, channelId, messageId),
            date: new Date(opened.timestamp).toISOString(),
            meta: { kind: "Discord", channel: where, shown: messages.length },
            text: `# Conversation in ${where} (Discord)\n\n${messages.map(line).join("\n\n")}`,
          },
        }
      },
    },
  ],
}
