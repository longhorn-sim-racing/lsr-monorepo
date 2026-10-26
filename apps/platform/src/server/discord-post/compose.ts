import { z } from "zod"
import { DISCORD_LIMITS } from "@/lib/discord/text"
import type { DiscordMessageBody, DiscordPollCreate, DiscordRole } from "@/server/connectors/discord/write"
import { pingParts, type PingTarget } from "./templates"
import { fromCentral, LOCAL_TIME, when } from "./time"

/**
 * Building one post (an announcement or a poll) from what Jack proposed or an officer typed on the
 * Announcements page: the poll, the ping, the send time, and the message Discord gets.
 */

/** The longest ahead a post can be scheduled */
export const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60_000

export const pollInput = z.object({
  question: z.string().trim().min(1).max(DISCORD_LIMITS.pollQuestion),
  answers: z.array(z.string().trim().min(1).max(DISCORD_LIMITS.pollAnswer)).min(2).max(DISCORD_LIMITS.pollAnswers),
  hours: z.number().int().min(1).max(DISCORD_LIMITS.pollHours).optional().describe("How long it's open, in hours (default 24, at most 768)"),
  multiselect: z.boolean().optional().describe("Let members pick more than one answer"),
})

export type PollInput = z.infer<typeof pollInput>

export function pollCreate(poll: PollInput): DiscordPollCreate {
  return {
    question: { text: poll.question },
    answers: poll.answers.map((text) => ({ poll_media: { text } })),
    duration: poll.hours ?? 24,
    allow_multiselect: Boolean(poll.multiselect),
    layout_type: 1,
  }
}

/**
 * The message Discord gets: the ping's mention first, then the text, and the poll. Discord has one switch
 * for @everyone and @here, so with a @here ping an "@everyone" in the text is broken up (a zero-width
 * space after the @): it shows, but pings nobody
 */
export function postBody({ text, poll, ping }: { text?: string | null; poll?: PollInput | null; ping?: PingTarget | null }): DiscordMessageBody {
  const { prefix, allowed } = pingParts(ping)
  const words = ping?.type === "here" ? (text ?? "").replace(/@(everyone)/gi, "@\u200b$1") : (text ?? "")
  const content = `${prefix}${words}`.trim()
  return { ...(content ? { content } : {}), ...(poll ? { poll: pollCreate(poll) } : {}), allowed_mentions: allowed }
}

/**
 * A ping as asked for ("everyone", "here", or a role by name or id) against the server's roles. @everyone
 * and @here need the bot to have Mention @everyone (the install link gives it; a server can take it
 * away); a role must be pingable by anyone, or the bot needs that permission too. Otherwise Discord
 * would show the mention without pinging anyone
 */
export function resolvePing(asked: string | null | undefined, { roles, mentionEveryone }: { roles: DiscordRole[]; mentionEveryone: boolean }): { ok: true; ping: PingTarget | null } | { ok: false; error: string } {
  const wanted = asked?.trim().replace(/^@/, "")
  if (!wanted) return { ok: true, ping: null }
  const lower = wanted.toLowerCase()
  if (lower === "everyone" || lower === "here") {
    if (!mentionEveryone) return { ok: false, error: `The bot can't ping @${lower}: it doesn't have Discord's "Mention @everyone, @here and All Roles" permission (a server admin can give it). Post without a ping, or ping a role.` }
    return { ok: true, ping: { type: lower } }
  }
  const role = roles.find((r) => r.id === wanted) ?? roles.find((r) => r.name.toLowerCase() === lower)
  if (!role || role.position === 0 || role.name === "@everyone") return { ok: false, error: `There's no role called @${wanted} in the server. Roles: ${roles.filter((r) => r.position > 0 && !r.managed).map((r) => `@${r.name}`).join(", ") || "none"}.` }
  if (!role.mentionable && !mentionEveryone) return { ok: false, error: `@${role.name} can't be pinged by the bot (it isn't set to "Allow anyone to @mention this role"). Post without a ping, or ask a server admin.` }
  return { ok: true, ping: { type: "role", roleId: role.id, name: role.name } }
}

/** A negation in the few words before an ask in the same sentence ("don't ping", "do not tag", "no need to mention", "without pinging"); "don't forget to ping" still asks */
const NEGATED = /\b(?:(?:don['’]?t|do\s+not)(?!\s+forget\b)|doesn['’]?t|does\s+not|no|not|never|without|avoid|skip)\b(?:\W+\w+){0,3}\W*$/i

/** Whether the pattern is in the text somewhere that isn't right after a negation */
function askedIn(text: string, pattern: RegExp): boolean {
  for (const m of text.matchAll(pattern)) {
    const sentence = text.slice(0, m.index).split(/[.!?\n]/).pop() ?? ""
    if (!NEGATED.test(sentence)) return true
  }
  return false
}

/**
 * Whether an officer asked for this ping in the room (design §12.1: no pings unless an officer names
 * one): their own message has the mention itself, or says to ping, tag, mention or notify that role (by
 * its whole name, or its plural) or everyone, and not right after a "don't" or "no"
 */
export function officerAskedPing(ping: PingTarget, officerTexts: string[]): boolean {
  const text = officerTexts.join("\n").toLowerCase()
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // "@name" as a whole word (not inside "@name_two" or an email address), and "ping the name"
  const at = (target: string) => new RegExp(`(?<!\\w)@${target}(?!\\w)`, "g")
  const verb = (target: string) => new RegExp(`\\b(?:ping|tag|mention|notify)\\W{0,3}(?:the\\s+)?${target}(?!\\w)`, "g")
  if (ping.type === "everyone" || ping.type === "here") return askedIn(text, at(ping.type)) || askedIn(text, verb(ping.type))
  const name = `${escape(ping.name.toLowerCase())}s?`
  return askedIn(text, new RegExp(`<@&${ping.roleId}>`, "g")) || askedIn(text, at(name)) || askedIn(text, verb(name))
}

/** When to send it: null for now, or a Central time in the next 30 days */
export function sendTime(sendAt: string | null | undefined, now = new Date()): { ok: true; at: Date | null } | { ok: false; error: string } {
  if (!sendAt?.trim()) return { ok: true, at: null }
  if (!LOCAL_TIME.test(sendAt.trim())) return { ok: false, error: "Use Central local time like 2026-10-26T18:00." }
  const at = fromCentral(sendAt.trim())
  if (!at) return { ok: false, error: `${sendAt} isn't a time on the calendar.` }
  if (at.getTime() <= now.getTime() + 60_000) return { ok: false, error: `${when(at)} has passed (or is a minute away). Leave the time out to post right away.` }
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) return { ok: false, error: "A post can be scheduled at most 30 days ahead." }
  return { ok: true, at }
}
