/**
 * The parts of Discord's REST API (v10) the club uses (research/discord.md §3). Only the fields we
 * read are typed; Discord sends more. Ids are snowflake strings: never parse them to a number.
 */

export type DiscordUser = {
  id: string
  username: string
  global_name?: string | null
  bot?: boolean
}

/** Channel types (research §3 R2) */
export const CHANNEL_TYPE = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  announcementThread: 10,
  publicThread: 11,
  privateThread: 12,
  stage: 13,
  forum: 15,
  media: 16,
} as const

/** Threads, which live inside another channel */
export const THREAD_TYPES: readonly number[] = [CHANNEL_TYPE.announcementThread, CHANNEL_TYPE.publicThread, CHANNEL_TYPE.privateThread]

/** The threads the sync reads: public ones. A private thread is only for the people in it, so it's never kept, even in an opted-in channel */
export const SYNCED_THREAD_TYPES: readonly number[] = [CHANNEL_TYPE.announcementThread, CHANNEL_TYPE.publicThread]

/** Channels whose own history holds messages (forum and media channels only hold threads) */
export const MESSAGE_CHANNEL_TYPES: readonly number[] = [CHANNEL_TYPE.text, CHANNEL_TYPE.voice, CHANNEL_TYPE.announcement, CHANNEL_TYPE.stage]

/** Channels that can have threads (Discord refuses to list a voice or stage channel's threads) */
export const THREAD_PARENT_TYPES: readonly number[] = [CHANNEL_TYPE.text, CHANNEL_TYPE.announcement, CHANNEL_TYPE.forum, CHANNEL_TYPE.media]

/** Channels an admin can opt in: the ones with messages, plus forums and media channels (their threads sync) */
export const SYNCABLE_CHANNEL_TYPES: readonly number[] = [...MESSAGE_CHANNEL_TYPES, CHANNEL_TYPE.forum, CHANNEL_TYPE.media]

export type DiscordChannel = {
  id: string
  type: number
  name?: string | null
  guild_id?: string
  parent_id?: string | null
  /** A thread's: who started it (for a forum post, its author) */
  owner_id?: string | null
  position?: number
  last_message_id?: string | null
  thread_metadata?: { archived: boolean; archive_timestamp: string; locked?: boolean }
}

export type DiscordGuild = {
  id: string
  name: string
  approximate_member_count?: number
  approximate_presence_count?: number
}

export type DiscordPollAnswer = { answer_id: number; poll_media: { text?: string } }

/** A poll on a message (research §3 R6). A missing `results` means unknown, not zero */
export type DiscordPoll = {
  question: { text?: string }
  answers: DiscordPollAnswer[]
  expiry: string | null
  allow_multiselect: boolean
  layout_type?: number
  results?: { is_finalized: boolean; answer_counts: { id: number; count: number; me_voted?: boolean }[] }
}

/** Message types we keep: 0 default and 19 reply. The rest are system messages (joins, pins, poll results) */
export const MESSAGE_TYPE = { default: 0, reply: 19 } as const

export type DiscordMessage = {
  id: string
  channel_id: string
  type: number
  timestamp: string
  edited_timestamp: string | null
  author: DiscordUser
  webhook_id?: string
  /** Empty without the Message Content intent */
  content: string
  attachments: unknown[]
  message_reference?: { message_id?: string; channel_id?: string } | null
  /** Omitted without the Message Content intent */
  poll?: DiscordPoll
}

export type DiscordMember = {
  user: DiscordUser
  nick?: string | null
  roles: string[]
  joined_at: string | null
  pending?: boolean
}

export type DiscordThreadList = { threads: DiscordChannel[]; has_more?: boolean }

/** The application, as its bot sees it (research §3 H1): `flags` says which privileged intents are on */
export type DiscordApplication = { id: string; name: string; flags?: number }

/** Application flags for the privileged intents an app under 100 servers toggles in the portal (and the verified-app versions) */
export const APP_FLAG = {
  guildMembers: 1 << 14,
  guildMembersLimited: 1 << 15,
  messageContent: 1 << 18,
  messageContentLimited: 1 << 19,
} as const

/** Search Guild Messages (research §3 R4): `messages` is a list of one-message lists */
export type DiscordSearchResponse = {
  total_results: number
  doing_deep_historical_index?: boolean
  messages: DiscordMessage[][]
  threads?: DiscordChannel[]
}

export type DiscordSearchParams = {
  content: string
  channelIds: string[]
  limit?: number
  offset?: number
  sortBy?: "relevance" | "timestamp"
  sortOrder?: "asc" | "desc"
}
