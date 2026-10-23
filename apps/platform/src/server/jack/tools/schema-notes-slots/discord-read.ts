import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the discord-read track's tables */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: `The club Discord (synced metadata only; the discord_activity and discord_polls tools read all of this with the club's rules)
- "DiscordChannel": the server's channels; synced = an admin opted it in. A thread has parentId (its channel) and counts toward it; threads are never opted in themselves.
- "DiscordMessage": one row per message in a synced channel or its threads: authorId (Discord user id), createdAt, contentLength, attachments, isReply, deletedAt (noticed by the hourly re-scan, within 7 days), and poll (JSON: question, answers [{id, text, votes}], finalized, expiresAt; votes null = not reported yet). There is no message text: search Discord for what was said. userId isn't filled in.
- "DiscordMember": the server's members (bots left out): username, displayName, roles, joinedAt, leftAt (missing from a later member list), userId when a site member linked the account.
- "DiscordDailyStat": per Central day and top-level channel (threads included): messages and activeAuthors (distinct authors that day; don't add those up across days). "DiscordGuildDaily": per Central day, memberCount, joinedCount, leftCount, from the day the member sync started.
- Discord's developer policy bans profiling individual users: answer with totals, never per-person counts, rankings or timelines, and never join DiscordMessage to people.`,
  tableNotes: {
    DiscordChannel: "A channel in the club server; synced = opted in. Threads have parentId.",
    DiscordMessage: "Metadata of a message in a synced channel (no text). Totals only, never per person.",
    DiscordMember: "A member of the club server; leftAt once they leave; userId when linked to a site member.",
    DiscordDailyStat: "Messages and distinct authors per Central day and channel (threads counted in their channel).",
    DiscordGuildDaily: "Server members, joins and leaves per Central day.",
  },
}
