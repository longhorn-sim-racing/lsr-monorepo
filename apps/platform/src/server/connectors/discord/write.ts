import { DISCORD_LIMITS } from "@/lib/discord/text"
import type { DiscordClient, DiscordRest } from "./client"
import type { DiscordMember, DiscordMessage } from "./types"

/**
 * What the club's bot writes to Discord (design §12.1, research/discord.md §3 W1 to W4): messages and
 * polls, scheduled events, and members' roles. Built on T7's REST client (`discordRest`), so writes share
 * its rate limiter, timeout, 401 stop and error shape; writes are never retried there on a 5xx; the
 * posting outbox (src/server/discord-post/outbox.ts) retries a message only with the same nonce.
 *
 * Reading stays in client.ts; nothing here changes how the sync reads.
 */

/** Who a message may ping. `parse: []` with no roles pings nobody, whatever the text says */
export type DiscordAllowedMentions = { parse: ("everyone" | "roles" | "users")[]; roles?: string[]; users?: string[] }

export type DiscordEmbed = {
  title?: string
  url?: string
  description?: string
  color?: number
  fields?: { name: string; value: string; inline?: boolean }[]
  footer?: { text: string }
  timestamp?: string
}

/** A poll as Create Message takes it (research §3 W2). Polls can't be edited once posted */
export type DiscordPollCreate = {
  question: { text: string }
  answers: { poll_media: { text: string } }[]
  /** Hours, 1 to 768 */
  duration: number
  allow_multiselect: boolean
  layout_type?: 1
}

/** Exactly what one post sends (DiscordPost.content): its text, embeds or poll, and who it may ping */
export type DiscordMessageBody = {
  content?: string
  embeds?: DiscordEmbed[]
  poll?: DiscordPollCreate
  allowed_mentions: DiscordAllowedMentions
}

export type DiscordRole = {
  id: string
  name: string
  position: number
  /** A bitfield as a decimal string */
  permissions: string
  /** Owned by an integration, a bot or boosting: nobody can grant it */
  managed: boolean
  /** Anyone may ping it, so a post can without Mention @everyone */
  mentionable: boolean
  color?: number
}

/** A guild scheduled event (research §3 W3) */
export type DiscordScheduledEvent = {
  id: string
  guild_id?: string
  channel_id: string | null
  creator_id?: string | null
  name: string
  description?: string | null
  scheduled_start_time: string
  scheduled_end_time: string | null
  privacy_level: number
  status: number
  entity_type: number
  entity_metadata: { location?: string } | null
  /** With with_user_count: how many members marked themselves interested */
  user_count?: number
}

/** An external event (somewhere outside Discord): the only kind the mirror makes */
export type ScheduledEventInput = {
  name: string
  description?: string
  scheduled_start_time: string
  scheduled_end_time: string
  entity_metadata: { location: string }
  channel_id: null
  privacy_level: 2
  entity_type: 3
}

export const SCHEDULED_EVENT_STATUS = { scheduled: 1, active: 2, completed: 3, canceled: 4 } as const

/** Discord's JSON error codes the writes name (research §3) */
export const DISCORD_WRITE_ERROR = {
  unknownRole: 10011,
  unknownEvent: 10070,
  emptyMessage: 50006,
  invalidBody: 50035,
  tooManyEvents: 30038,
} as const

/** Everything wrong with a message against Discord's limits, in words; empty when it can be sent */
export function messageProblems(body: DiscordMessageBody): string[] {
  const problems: string[] = []
  const content = body.content ?? ""
  const embeds = body.embeds ?? []
  if (!content.trim() && !embeds.length && !body.poll) problems.push("The message is empty.")
  if (content.length > DISCORD_LIMITS.content) problems.push(`The text is ${content.length} characters; Discord takes ${DISCORD_LIMITS.content}.`)
  if (embeds.length > DISCORD_LIMITS.embeds) problems.push(`${embeds.length} embeds; Discord takes ${DISCORD_LIMITS.embeds}.`)
  let total = 0
  for (const embed of embeds) {
    total += (embed.title ?? "").length + (embed.description ?? "").length + (embed.footer?.text ?? "").length
    if ((embed.title ?? "").length > DISCORD_LIMITS.embedTitle) problems.push(`An embed's title is over ${DISCORD_LIMITS.embedTitle} characters.`)
    if ((embed.description ?? "").length > DISCORD_LIMITS.embedDescription) problems.push(`An embed's text is over ${DISCORD_LIMITS.embedDescription} characters.`)
    if ((embed.footer?.text ?? "").length > DISCORD_LIMITS.footer) problems.push(`An embed's footer is over ${DISCORD_LIMITS.footer} characters.`)
    const fields = embed.fields ?? []
    if (fields.length > DISCORD_LIMITS.embedFields) problems.push(`An embed has ${fields.length} fields; Discord takes ${DISCORD_LIMITS.embedFields}.`)
    for (const field of fields) {
      total += field.name.length + field.value.length
      if (!field.name || field.name.length > DISCORD_LIMITS.fieldName) problems.push("An embed field's name is empty or too long.")
      if (!field.value || field.value.length > DISCORD_LIMITS.fieldValue) problems.push("An embed field's value is empty or too long.")
    }
  }
  if (total > DISCORD_LIMITS.embedTotal) problems.push(`The embeds hold ${total} characters; Discord takes ${DISCORD_LIMITS.embedTotal}.`)
  if (body.poll) {
    const poll = body.poll
    if (!poll.question.text.trim() || poll.question.text.length > DISCORD_LIMITS.pollQuestion) problems.push(`A poll's question is 1 to ${DISCORD_LIMITS.pollQuestion} characters.`)
    if (poll.answers.length < 1 || poll.answers.length > DISCORD_LIMITS.pollAnswers) problems.push(`A poll has 1 to ${DISCORD_LIMITS.pollAnswers} answers.`)
    if (poll.answers.some((a) => !a.poll_media.text.trim() || a.poll_media.text.length > DISCORD_LIMITS.pollAnswer)) problems.push(`Each poll answer is 1 to ${DISCORD_LIMITS.pollAnswer} characters.`)
    if (!Number.isInteger(poll.duration) || poll.duration < 1 || poll.duration > DISCORD_LIMITS.pollHours) problems.push(`A poll runs 1 to ${DISCORD_LIMITS.pollHours} hours.`)
  }
  return problems
}

/** Who a message pings, in words: "nobody", "@everyone", "1 role" */
export function pingsOf(body: Pick<DiscordMessageBody, "allowed_mentions">): { everyone: boolean; roles: string[] } {
  return { everyone: body.allowed_mentions.parse.includes("everyone"), roles: body.allowed_mentions.roles ?? [] }
}

// ---------------------------------------------------------------------------
// Permissions and the role safety rules (role sync, the smoke test)
// ---------------------------------------------------------------------------

const bit = (n: number) => BigInt(1) << BigInt(n)

/** Permission bits (Discord's permissions topic). BigInt: several sit above 2^31 */
export const PERMISSION = {
  kickMembers: bit(1),
  banMembers: bit(2),
  administrator: bit(3),
  manageChannels: bit(4),
  manageGuild: bit(5),
  viewAuditLog: bit(7),
  manageMessages: bit(13),
  mentionEveryone: bit(17),
  muteMembers: bit(22),
  deafenMembers: bit(23),
  moveMembers: bit(24),
  manageNicknames: bit(27),
  manageRoles: bit(28),
  manageWebhooks: bit(29),
  manageGuildExpressions: bit(30),
  manageEvents: bit(33),
  manageThreads: bit(34),
  moderateMembers: bit(40),
  viewCreatorMonetizationAnalytics: bit(41),
} as const

/**
 * Permissions that make a role a moderation or admin role (everything Discord asks 2FA for, plus the
 * ones that act on other members, read the audit log or ping everyone). Role sync never grants or
 * removes a role holding any of them
 */
export const MODERATION_PERMISSIONS: { bit: bigint; name: string }[] = [
  { bit: PERMISSION.administrator, name: "Administrator" },
  { bit: PERMISSION.kickMembers, name: "Kick Members" },
  { bit: PERMISSION.banMembers, name: "Ban Members" },
  { bit: PERMISSION.manageChannels, name: "Manage Channels" },
  { bit: PERMISSION.manageGuild, name: "Manage Server" },
  { bit: PERMISSION.viewAuditLog, name: "View Audit Log" },
  { bit: PERMISSION.manageMessages, name: "Manage Messages" },
  { bit: PERMISSION.mentionEveryone, name: "Mention @everyone" },
  { bit: PERMISSION.muteMembers, name: "Mute Members" },
  { bit: PERMISSION.deafenMembers, name: "Deafen Members" },
  { bit: PERMISSION.moveMembers, name: "Move Members" },
  { bit: PERMISSION.manageNicknames, name: "Manage Nicknames" },
  { bit: PERMISSION.manageRoles, name: "Manage Roles" },
  { bit: PERMISSION.manageWebhooks, name: "Manage Webhooks" },
  { bit: PERMISSION.manageGuildExpressions, name: "Manage Expressions" },
  { bit: PERMISSION.manageEvents, name: "Manage Events" },
  { bit: PERMISSION.manageThreads, name: "Manage Threads" },
  { bit: PERMISSION.moderateMembers, name: "Timeout Members" },
  { bit: PERMISSION.viewCreatorMonetizationAnalytics, name: "View Creator Monetization Analytics" },
]

function permissionBits(permissions: string | undefined): bigint {
  try {
    return BigInt(permissions ?? "0")
  } catch {
    // Unreadable means unknown: treat it as holding everything
    return ~BigInt(0)
  }
}

/** The moderation permissions a role holds, by name */
export function moderationPermissions(role: Pick<DiscordRole, "permissions">): string[] {
  const bits = permissionBits(role.permissions)
  if (bits & PERMISSION.administrator) return ["Administrator"]
  return MODERATION_PERMISSIONS.filter((p) => bits & p.bit).map((p) => p.name)
}

/** Whether a role has a permission (Administrator has them all) */
export function roleHas(role: Pick<DiscordRole, "permissions">, permission: bigint): boolean {
  const bits = permissionBits(role.permissions)
  return Boolean(bits & PERMISSION.administrator) || Boolean(bits & permission)
}

/** The bot's own place among the roles: its highest role's position, and whether any of its roles is an admin role */
export function botStanding(roles: DiscordRole[], botRoleIds: readonly string[]): { top: number; topRole: DiscordRole | null; administrator: boolean; mentionEveryone: boolean } {
  const own = roles.filter((r) => botRoleIds.includes(r.id))
  const topRole = own.reduce<DiscordRole | null>((best, r) => (!best || r.position > best.position ? r : best), null)
  // @everyone's permissions apply to the bot too
  const everyone = roles.find((r) => r.position === 0 && r.name === "@everyone")
  const all = everyone ? [...own, everyone] : own
  return {
    top: topRole?.position ?? 0,
    topRole,
    administrator: own.some((r) => Boolean(permissionBits(r.permissions) & PERMISSION.administrator)),
    mentionEveryone: all.some((r) => roleHas(r, PERMISSION.mentionEveryone)),
  }
}

/**
 * Why role sync may not manage a role, or null when it may (design §12.1: non-moderation roles only,
 * below the bot's own). @everyone, managed roles (a bot's, boosters'), roles with a moderation
 * permission, and roles at or above the bot's highest role are refused
 */
export function roleSyncRefusal(role: DiscordRole | undefined, { guildId, botTop }: { guildId: string; botTop: number }): string | null {
  if (!role) return "The role no longer exists in Discord."
  if (role.id === guildId || role.name === "@everyone") return "@everyone can't be synced."
  if (role.managed) return `@${role.name} belongs to an integration or a bot, so nobody can hand it out.`
  const moderation = moderationPermissions(role)
  if (moderation.length) return `@${role.name} has moderation permissions (${moderation.slice(0, 3).join(", ")}${moderation.length > 3 ? ", …" : ""}); role sync only hands out plain roles.`
  if (role.position >= botTop) return `@${role.name} sits at or above the bot's own role; move the bot's role above it in Server Settings → Roles.`
  return null
}

/**
 * The bot's place in the server's roles, for the smoke test (design §12.1: the bot's role sits below
 * admin roles): its highest role must sit below every role with Administrator, Manage Server or Manage
 * Roles, and the bot itself mustn't hold Administrator. Null when that's all fine
 */
export function botRoleProblem(roles: DiscordRole[], botRoleIds: readonly string[]): string | null {
  const standing = botStanding(roles, botRoleIds)
  if (standing.administrator) return "The bot's role has Administrator; give it only the permissions in the install link."
  const admins = roles.filter((r) => !botRoleIds.includes(r.id) && !r.managed && r.position > 0 && (roleHas(r, PERMISSION.manageGuild) || roleHas(r, PERMISSION.manageRoles)))
  const below = admins.filter((r) => r.position <= standing.top)
  if (below.length) return `The bot's role (${standing.topRole ? `@${standing.topRole.name}` : "none"}) sits above ${below.map((r) => `@${r.name}`).slice(0, 3).join(", ")}; move it below the admin roles (Server Settings → Roles).`
  return null
}

/** The smoke test's role check, read live: the bot's place among the server's roles (botRoleProblem), or null when it's fine */
export async function botRoleCheck(client: Pick<DiscordClient, "rest" | "guildId" | "botUser">, signal?: AbortSignal): Promise<string | null> {
  const writer = discordWriter(client.rest, client.guildId)
  const [roles, me] = await Promise.all([writer.roles(signal), client.botUser(signal)])
  const bot = await writer.member(me.id, signal)
  return botRoleProblem(roles, bot.roles)
}

// ---------------------------------------------------------------------------
// The writes
// ---------------------------------------------------------------------------

/** A message's address in Discord's app and web client */
export function discordMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

/** A scheduled event's address in Discord */
export function discordEventUrl(guildId: string, eventId: string): string {
  return `https://discord.com/events/${guildId}/${eventId}`
}

/** The bot's writes to the club server, on top of a REST client (`discordClient(...).rest`) */
export function discordWriter(rest: DiscordRest, guildId: string) {
  const guild = encodeURIComponent(guildId)
  const id = (value: string) => encodeURIComponent(value)

  return {
    guildId,
    /**
     * Posts a message (W1, W2). `nonce` with enforce_nonce: if the bot already posted a message with this
     * nonce in the last few minutes, Discord returns that one instead of posting again, so a retry after
     * a dropped connection can't post twice
     */
    async createMessage(channelId: string, body: DiscordMessageBody, nonce: string, signal?: AbortSignal): Promise<DiscordMessage> {
      const sent = await rest.request<DiscordMessage>("POST", `/channels/${id(channelId)}/messages`, { body: { ...body, nonce, enforce_nonce: true }, signal })
      return sent.data
    },
    /** Up to 100 messages after a snowflake, newest first (what a send that went unconfirmed is checked against) */
    messagesAfter: (channelId: string, after: string, signal?: AbortSignal) => rest.get<DiscordMessage[]>(`/channels/${id(channelId)}/messages`, { query: { after, limit: 100 }, signal }),
    /** Ends one of the bot's own polls now */
    expirePoll: async (channelId: string, messageId: string, signal?: AbortSignal) => (await rest.request<DiscordMessage>("POST", `/channels/${id(channelId)}/polls/${id(messageId)}/expire`, { signal })).data,
    /** The server's roles, with positions and permissions */
    roles: (signal?: AbortSignal) => rest.get<DiscordRole[]>(`/guilds/${guild}/roles`, { signal }),
    /** One member, roles included (404 10007 when they aren't in the server) */
    member: (userId: string, signal?: AbortSignal) => rest.get<DiscordMember>(`/guilds/${guild}/members/${id(userId)}`, { signal }),
    /** Gives a member a role (W4); Discord answers 204, and nothing changes if they have it */
    async addRole(userId: string, roleId: string, reason: string, signal?: AbortSignal): Promise<void> {
      await rest.request("PUT", `/guilds/${guild}/members/${id(userId)}/roles/${id(roleId)}`, { auditReason: reason, signal })
    },
    async removeRole(userId: string, roleId: string, reason: string, signal?: AbortSignal): Promise<void> {
      await rest.request("DELETE", `/guilds/${guild}/members/${id(userId)}/roles/${id(roleId)}`, { auditReason: reason, signal })
    },
    /** The server's scheduled and active events, with how many members are interested */
    scheduledEvents: (signal?: AbortSignal) => rest.get<DiscordScheduledEvent[]>(`/guilds/${guild}/scheduled-events`, { query: { with_user_count: true }, signal }),
    async createScheduledEvent(input: ScheduledEventInput, reason: string, signal?: AbortSignal): Promise<DiscordScheduledEvent> {
      return (await rest.request<DiscordScheduledEvent>("POST", `/guilds/${guild}/scheduled-events`, { body: input, auditReason: reason, signal })).data
    },
    async updateScheduledEvent(eventId: string, patch: Partial<ScheduledEventInput> & { status?: number }, reason: string, signal?: AbortSignal): Promise<DiscordScheduledEvent> {
      return (await rest.request<DiscordScheduledEvent>("PATCH", `/guilds/${guild}/scheduled-events/${id(eventId)}`, { body: patch, auditReason: reason, signal })).data
    },
    async deleteScheduledEvent(eventId: string, reason: string, signal?: AbortSignal): Promise<void> {
      await rest.request("DELETE", `/guilds/${guild}/scheduled-events/${id(eventId)}`, { auditReason: reason, signal })
    },
  }
}

export type DiscordWriter = ReturnType<typeof discordWriter>
