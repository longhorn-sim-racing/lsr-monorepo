import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the discord-post track's tables */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: `Posting to the club Discord (propose_discord proposes; officers apply)
- "DiscordRule": standing automations. kind is event_reminder, new_event, results_posted, standings_update, twitch_live or event_mirror; "channelId" is where it posts (null for event_mirror); config (JSON) holds offsets (minutes before an event), series (an EventSeries slug), top, ping ({ type: "role", roleId, name }) and location; enabled; "cutoffAt": it only acts on what happened after this (moved to when it was last switched on).
- "DiscordPost": every message the bot posts or will post. source is rule, proposal, admin (an officer on Announcements) or digest; "ruleId" or "proposalId" says which; status SCHEDULED (waiting for "scheduledFor"), SENDING, SENT ("sentAt", "discordMessageId"), FAILED or CANCELLED (error says why); content is exactly what Discord gets ({ content, embeds?, poll?, allowed_mentions }); "dedupeKey" keeps it to one post per thing ("proposal:<id>", "event_reminder:<rule>:<event>:<start>:<minutes>").
- "DiscordEventMirror": our event (eventId) and its Discord scheduled event, with "interestedCount" (members interested in Discord).
- "DiscordRoleRule": role sync: linked members who meet condition (linked, officer, lsc_driver, collegiate_driver, lsc_entered) get the Discord role "roleId"; enabled. The posting channels list is a setting Jack can't read; the discord.post error lists them.`,
  tableNotes: {
    DiscordRule: "A standing Discord automation (template posts or the event mirror); enabled; acts only after cutoffAt.",
    DiscordPost: "A message the bot posts or posted: source, status, scheduledFor, sentAt, error; content is the exact message.",
    DiscordEventMirror: "One of our events mirrored as a Discord scheduled event, with Discord's interested count.",
    DiscordRoleRule: "Role sync: the Discord role linked members get while they meet the condition.",
  },
}
