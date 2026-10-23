import { createHmac } from "node:crypto"
import { MESSAGE_TYPE, type DiscordMessage, type DiscordPoll } from "./types"

/**
 * What the club keeps of a Discord message (design §12.1): metadata only. Never its words: the length
 * of its text, how many attachments, whether it's a reply, and for a poll its question, answers and
 * vote counts (never who voted). Members whose data was purged on request are left out for good.
 */

/** A poll as DiscordMessage.poll stores it. `votes` null means Discord hasn't said yet (unknown, not zero) */
export type StoredPoll = {
  question: string
  answers: { id: number; text: string; votes: number | null }[]
  multiselect: boolean
  /** ISO; null for a poll with no end */
  expiresAt: string | null
  /** Discord's counts are exact only once it's finalized */
  finalized: boolean
  /** When the counts were last read (ISO), or null when Discord never gave any */
  countedAt: string | null
}

/** A DiscordMessage row, as the sync writes it */
export type MessageRow = {
  id: string
  channelId: string
  authorId: string
  createdAt: Date
  editedAt: Date | null
  contentLength: number
  attachments: number
  isReply: boolean
  poll: StoredPoll | null
  lastSeenAt: Date
}

/**
 * The do-not-collect list: members whose Discord data was purged on request. Ask it by Discord user id;
 * it holds only keyed hashes of them (purgedHash)
 */
export type PurgedList = { has(discordUserId: string): boolean; readonly size: number }

/**
 * How a purged member's Discord id is kept on the list: an HMAC under the list's own random key (kept
 * with the list in SystemSetting, which Jack can't read and no page shows). Keyed, because Discord ids
 * are visible to everyone in the server: a plain hash would let anyone check whether someone asked
 */
export function purgedHash(key: string, discordUserId: string): string {
  return createHmac("sha256", Buffer.from(key, "base64url")).update(`lsr-discord-purged:${discordUserId}`).digest("hex")
}

/** A list from its key and hashes (no key: nobody was purged yet) */
export function purgedList(key: string | null, hashes: Iterable<string>): PurgedList {
  const stored = new Set(hashes)
  return { has: (discordUserId) => Boolean(key && stored.size && stored.has(purgedHash(key, discordUserId))), size: stored.size }
}

/**
 * Whether the sync keeps a message: members' ordinary messages and replies, and any message with a poll
 * (the bot's own polls included). Not system messages (joins, pins), not other bots or webhooks, and
 * never anyone on the purged list
 */
export function keepMessage(message: DiscordMessage, purged: PurgedList): boolean {
  if (purged.has(message.author.id)) return false
  if (message.poll) return true
  if (message.type !== MESSAGE_TYPE.default && message.type !== MESSAGE_TYPE.reply) return false
  return !message.author.bot && !message.webhook_id
}

/**
 * A poll's question, answers and counts, merged with what was stored: a missing `results` keeps the
 * last known counts (Discord omits it sometimes), and an answer missing from the counts has 0 votes
 */
export function storedPoll(poll: DiscordPoll, previous: StoredPoll | null, now: Date): StoredPoll {
  const results = poll.results
  const counts = new Map(results?.answer_counts.map((c) => [c.id, c.count]) ?? [])
  const known = new Map(previous?.answers.map((a) => [a.id, a.votes]) ?? [])
  return {
    question: (poll.question.text ?? "").slice(0, 300),
    answers: poll.answers.map((answer) => ({
      id: answer.answer_id,
      text: (answer.poll_media.text ?? "").slice(0, 55),
      votes: results ? (counts.get(answer.answer_id) ?? 0) : (known.get(answer.answer_id) ?? null),
    })),
    multiselect: Boolean(poll.allow_multiselect),
    expiresAt: poll.expiry ? new Date(poll.expiry).toISOString() : null,
    finalized: results ? Boolean(results.is_finalized) : (previous?.finalized ?? false),
    countedAt: results ? now.toISOString() : (previous?.countedAt ?? null),
  }
}

/** Reads a stored poll back (the column is JSON), or null when it isn't one */
export function readStoredPoll(value: unknown): StoredPoll | null {
  if (!value || typeof value !== "object") return null
  const poll = value as Partial<StoredPoll>
  if (typeof poll.question !== "string" || !Array.isArray(poll.answers)) return null
  return {
    question: poll.question,
    answers: poll.answers.filter((a) => a && typeof a.id === "number" && typeof a.text === "string").map((a) => ({ id: a.id, text: a.text, votes: typeof a.votes === "number" ? a.votes : null })),
    multiselect: Boolean(poll.multiselect),
    expiresAt: typeof poll.expiresAt === "string" ? poll.expiresAt : null,
    finalized: Boolean(poll.finalized),
    countedAt: typeof poll.countedAt === "string" ? poll.countedAt : null,
  }
}

/**
 * The row for a message. Without the Message Content intent Discord sends no text and no poll, so an
 * update keeps what was stored for those rather than writing zeros over it
 */
export function messageRow(message: DiscordMessage, now: Date, previous?: { contentLength: number; poll: StoredPoll | null } | null): MessageRow {
  const previousPoll = previous?.poll ?? null
  return {
    id: message.id,
    channelId: message.channel_id,
    authorId: message.author.id,
    createdAt: new Date(message.timestamp),
    editedAt: message.edited_timestamp ? new Date(message.edited_timestamp) : null,
    contentLength: message.content ? message.content.length : (previous?.contentLength ?? 0),
    attachments: Array.isArray(message.attachments) ? message.attachments.length : 0,
    isReply: message.type === MESSAGE_TYPE.reply,
    poll: message.poll ? storedPoll(message.poll, previousPoll, now) : previousPoll,
    lastSeenAt: now,
  }
}
