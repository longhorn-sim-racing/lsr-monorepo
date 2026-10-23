import { z } from "zod"
import { prisma } from "@/server/db"
import { createAuditLog } from "@/server/audit/log"
import { messageProblems } from "@/server/connectors/discord/write"
import { channelList, postingChannels } from "./channels"
import { pollInput, postBody, resolvePing, sendTime } from "./compose"
import type { DiscordPosting } from "./connection"
import { cancelPosts, postUrl, queueDiscordPost, sendOutcomeAudit, sendPostNow, type SendOutcome } from "./outbox"
import { duePostProblem } from "./post-check"
import { readRoles } from "./role-sync"
import { pingLabel, type PingTarget } from "./templates"
import { when } from "./time"

/**
 * Posts officers make themselves on Community → Announcements (source "admin"), and what any officer can
 * do to a post in the outbox: cancel one that's scheduled, retry one that failed. The officer wrote the
 * text, so it goes as typed; it still pings nobody unless they pick a ping (and a @here ping never lets
 * an @everyone in the text through). Every one is audited (entityType DISCORD_POST), after the send, with
 * how it ended.
 */

export const officerPostInput = z
  .object({
    channelId: z.string().regex(/^\d{17,20}$/, "Pick a channel."),
    text: z.string().trim().max(2000).optional(),
    poll: pollInput.optional(),
    /** A role id, "everyone" or "here" */
    ping: z.string().trim().max(32).optional(),
    /** Central local time; empty to post now */
    sendAt: z.string().trim().optional(),
  })
  .refine((p) => Boolean(p.text?.trim()) || Boolean(p.poll), { message: "Write the message, add a poll, or both." })

export type OfficerPostInput = z.infer<typeof officerPostInput>

type Actor = { userId: string; displayName: string }

/** A channel's name from the synced channels, for an audit entry */
async function channelName(id: string): Promise<string | null> {
  return (await prisma.discordChannel.findUnique({ where: { id }, select: { name: true } }))?.name ?? null
}

export type OfficerPostResult = { ok: true; status: "SENT" | "SCHEDULED" | "WAITING"; url: string | null; summary: string } | { ok: false; error: string }

export async function createOfficerPost(raw: unknown, actor: Actor, posting: DiscordPosting): Promise<OfficerPostResult> {
  const parsed = officerPostInput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the post's fields." }
  const input = parsed.data
  const channels = await postingChannels()
  const channel = channels.find((c) => c.id === input.channelId)
  if (!channel) return { ok: false, error: `Pick a posting channel: ${channelList(channels)}.` }
  const time = sendTime(input.sendAt, new Date())
  if (!time.ok) return { ok: false, error: time.error }

  let ping: PingTarget | null = null
  if (input.ping) {
    const live = await readRoles(posting.client, posting.writer).catch(() => null)
    if (!live) return { ok: false, error: "Couldn't read the server's roles from Discord just now. Try again, or post without a ping." }
    const resolved = resolvePing(input.ping, { roles: live.roles, mentionEveryone: live.mentionEveryone })
    if (!resolved.ok) return { ok: false, error: resolved.error }
    ping = resolved.ping
  }
  const body = postBody({ text: input.text, poll: input.poll, ping })
  const problems = messageProblems(body)
  if (problems.length) return { ok: false, error: problems.join(" ") }

  const { post } = await queueDiscordPost({ source: "admin", channelId: channel.id, body, scheduledFor: time.at ?? new Date(), createdById: actor.userId, approvedById: actor.userId })
  const audit = (start: string, extra: { status: string; error?: string | null }) =>
    createAuditLog({
      actorUserId: actor.userId,
      actionType: time.at ? "SCHEDULE" : "CREATE",
      entityType: "DISCORD_POST",
      entityId: post.id,
      summary: `${start}${ping ? `, pinging ${pingLabel(ping)}` : ""}`,
      after: { channelId: channel.id, content: (body.content ?? "").slice(0, 500), poll: body.poll?.question.text ?? null, scheduledFor: post.scheduledFor.toISOString(), status: extra.status, ...(extra.error ? { error: extra.error } : {}) },
    })
  if (time.at) {
    await audit(`Scheduled a Discord post for ${when(time.at)} in #${channel.name}`, { status: "SCHEDULED" })
    return { ok: true, status: "SCHEDULED", url: null, summary: `Scheduled for ${when(time.at)} in #${channel.name}.` }
  }

  let outcome: SendOutcome | undefined
  try {
    outcome = await sendPostNow(post.id, posting.writer)
  } finally {
    // Written after the send, so the log says what really happened
    const words = sendOutcomeAudit(outcome, channel.name)
    await audit(words.summary, words)
  }
  if (outcome.status === "SENT") return { ok: true, status: "SENT", url: postUrl({ channelId: channel.id, discordMessageId: outcome.messageId }), summary: `Posted in #${channel.name}.` }
  if (outcome.status === "FAILED") return { ok: false, error: `Couldn't post it: ${outcome.error}` }
  return { ok: true, status: "WAITING", url: null, summary: `It goes out in #${channel.name} within a few minutes.` }
}

/** Cancels a scheduled post (any officer). A rule won't make it again */
export async function cancelScheduledPost(id: string, actor: Actor): Promise<{ ok: true } | { ok: false; error: string }> {
  const count = await cancelPosts({ id }, `Cancelled by ${actor.displayName}.`, { release: false })
  if (!count) return { ok: false, error: "It isn't waiting to be sent anymore. Reload the page." }
  await createAuditLog({ actorUserId: actor.userId, actionType: "CANCEL", entityType: "DISCORD_POST", entityId: id, summary: "Cancelled a scheduled Discord post" })
  return { ok: true }
}

/**
 * Sends a failed post again (any officer, after checking the channel): back to scheduled for now, with
 * the same nonce, so if Discord did post it in the last few minutes it returns that message instead of
 * posting twice. It gets the posts job's last check first (duePostProblem: still a posting channel, and
 * a rule's post still wanted), and is cancelled instead when that fails. Sends right away when Discord
 * is on
 */
export async function retryFailedPost(id: string, actor: Actor, posting: DiscordPosting | null): Promise<OfficerPostResult> {
  const { count } = await prisma.discordPost.updateMany({ where: { id, status: "FAILED" }, data: { status: "SCHEDULED", scheduledFor: new Date(), claimedAt: null, error: null } })
  if (!count) return { ok: false, error: "It isn't a failed post anymore. Reload the page." }
  const queued = await prisma.discordPost.findUniqueOrThrow({ where: { id } })
  const problem = await duePostProblem(queued, new Date())
  if (problem) {
    await cancelPosts({ id }, problem, { release: true })
    await createAuditLog({ actorUserId: actor.userId, actionType: "CANCEL", entityType: "DISCORD_POST", entityId: id, summary: `Cancelled a failed Discord post instead of sending it again: ${problem}`, after: { status: "CANCELLED", error: problem } })
    return { ok: false, error: `It wasn't sent again, and it's cancelled now: ${problem}` }
  }
  if (!posting) {
    await createAuditLog({ actorUserId: actor.userId, actionType: "RETRY", entityType: "DISCORD_POST", entityId: id, summary: "Queued a failed Discord post again (Discord is off; it goes out once it's back on)", after: { status: "SCHEDULED" } })
    return { ok: true, status: "WAITING", url: null, summary: "It goes out once Discord is switched on again (within 6 hours, or it's cancelled)." }
  }
  let outcome: SendOutcome | undefined
  try {
    outcome = await sendPostNow(id, posting.writer)
  } finally {
    const words = sendOutcomeAudit(outcome, (await channelName(queued.channelId)) ?? queued.channelId)
    await createAuditLog({ actorUserId: actor.userId, actionType: "RETRY", entityType: "DISCORD_POST", entityId: id, summary: `Sent a failed Discord post again: ${words.summary.charAt(0).toLowerCase()}${words.summary.slice(1)}`, after: { status: words.status, ...(words.error ? { error: words.error } : {}) } })
  }
  const post = await prisma.discordPost.findUnique({ where: { id }, select: { channelId: true, discordMessageId: true } })
  if (outcome.status === "SENT") return { ok: true, status: "SENT", url: post ? postUrl(post) : null, summary: "Posted." }
  if (outcome.status === "FAILED") return { ok: false, error: `It failed again: ${outcome.error}` }
  return { ok: true, status: "WAITING", url: null, summary: "It goes out within a few minutes." }
}
