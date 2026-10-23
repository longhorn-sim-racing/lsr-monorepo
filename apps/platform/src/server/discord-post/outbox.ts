import { createHash, randomUUID } from "node:crypto"
import { Prisma, type DiscordPost } from "@prisma/client"
import { redactSecrets } from "@/lib/redact"
import { prisma } from "@/server/db"
import { DISCORD_ERROR, DiscordApiError, DiscordRateLimitError, sleep } from "@/server/connectors/discord/client"
import { snowflakeAt } from "@/server/connectors/discord/snowflake"
import type { DiscordMessage } from "@/server/connectors/discord/types"
import { discordMessageUrl, messageProblems, type DiscordEmbed, type DiscordMessageBody, type DiscordWriter } from "@/server/connectors/discord/write"
import { when } from "./time"

/**
 * The Discord outbox (design §12.1 "Posting"): every message the bot posts is a DiscordPost row first,
 * whether a standing rule, an applied proposal, an officer on the Announcements page or the weekly digest
 * made it. Then:
 * - **one sender:** a post is claimed with a conditional update (SCHEDULED → SENDING, `claimedAt`), so of
 *   two runs (or a run and an Apply) only one sends it;
 * - **no double posts:** each post has its own Discord `nonce`, sent with `enforce_nonce`. A send whose
 *   answer never came back (a dropped connection, a timeout, a 5xx) is tried again at once with the same
 *   nonce, which Discord dedupes for a few minutes. If it still isn't confirmed, the channel's recent
 *   history is checked for it: found means SENT, not found means FAILED for an officer to look at. Nothing
 *   is ever re-sent blind after that;
 * - **rate limits:** the REST client waits out each route's bucket; a longer limit puts the post back
 *   for the next run (Discord didn't take it);
 * - **errors** are stored redacted on the post.
 * Posts that miss their time by more than LATE_LIMIT_MS are cancelled, not sent late.
 */

/** Where a post came from (DiscordPost.source). "digest" is the weekly digest (automation track) */
export const POST_SOURCES = ["rule", "proposal", "admin", "digest"] as const
export type PostSource = (typeof POST_SOURCES)[number]

/** A post is never sent more than this late: after it, it's cancelled */
export const LATE_LIMIT_MS = 6 * 60 * 60_000
/** A post still SENDING after this long was claimed by a run that stopped: the next run checks the channel for it */
export const STUCK_AFTER_MS = 3 * 60_000
/** Sends per run of the posts job; the rest wait for the next one */
export const MAX_SENDS_PER_RUN = 10
/** Tries per send when no answer came back, with these pauses between them (seconds apart, well inside Discord's nonce window) */
const SEND_TRIES = 3
const RETRY_PAUSES_MS = [1_000, 3_000]
/** Stored errors are cut to this */
const ERROR_CHARS = 500

/** Discord's nonce for a post: from its id, so every try of one post carries the same one (at most 25 characters) */
export function postNonce(postId: string): string {
  return createHash("sha256").update(`lsr-discord-post:${postId}`).digest("base64url").slice(0, 25)
}

/** A stored DiscordPost.content read back as a message, or null when it isn't one */
export function readBody(content: unknown): DiscordMessageBody | null {
  if (!content || typeof content !== "object") return null
  const body = content as Partial<DiscordMessageBody>
  if (!body.allowed_mentions || !Array.isArray(body.allowed_mentions.parse)) return null
  if (body.content !== undefined && typeof body.content !== "string") return null
  if (body.embeds !== undefined && !Array.isArray(body.embeds)) return null
  return body as DiscordMessageBody
}

const json = (body: DiscordMessageBody) => body as unknown as Prisma.InputJsonValue
const stored = (text: string) => redactSecrets(text).slice(0, ERROR_CHARS)

export type QueuePostInput = {
  source: PostSource
  channelId: string
  body: DiscordMessageBody
  /** When to send it; now when left out */
  scheduledFor?: Date
  /** One post per thing ("proposal:<id>", "event_reminder:…"): a second queue with the same key returns the first post */
  dedupeKey?: string | null
  ruleId?: string | null
  proposalId?: string | null
  createdById?: string | null
  approvedById?: string | null
}

/**
 * Adds a post to the outbox (SCHEDULED). With a dedupeKey that's taken, nothing is added and the post
 * that holds it comes back (`created: false`), whatever its status. Throws when the message breaks
 * Discord's limits
 */
export async function queueDiscordPost(input: QueuePostInput, db: Prisma.TransactionClient = prisma): Promise<{ post: DiscordPost; created: boolean }> {
  const problems = messageProblems(input.body)
  if (problems.length) throw new Error(`The message can't be sent: ${problems.join(" ")}`)
  // Taken already (a second Apply, a rule's next run): the usual case, so it's read first; the unique index still settles a race
  if (input.dedupeKey) {
    const existing = await db.discordPost.findUnique({ where: { dedupeKey: input.dedupeKey } })
    if (existing) return { post: existing, created: false }
  }
  const id = randomUUID()
  try {
    const post = await db.discordPost.create({
      data: {
        id,
        source: input.source,
        ruleId: input.ruleId ?? null,
        proposalId: input.proposalId ?? null,
        channelId: input.channelId,
        content: json(input.body),
        dedupeKey: input.dedupeKey ?? null,
        nonce: postNonce(id),
        status: "SCHEDULED",
        scheduledFor: input.scheduledFor ?? new Date(),
        createdById: input.createdById ?? null,
        approvedById: input.approvedById ?? null,
      },
    })
    return { post, created: true }
  } catch (error) {
    if (!input.dedupeKey || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error
    const existing = await db.discordPost.findUnique({ where: { dedupeKey: input.dedupeKey } })
    if (!existing) throw error
    return { post: existing, created: false }
  }
}

/** Claims a due post for sending: SCHEDULED → SENDING, in one conditional update. Of two callers, exactly one gets it */
export async function claimPost(id: string, now: Date): Promise<boolean> {
  const { count } = await prisma.discordPost.updateMany({ where: { id, status: "SCHEDULED", scheduledFor: { lte: now } }, data: { status: "SENDING", claimedAt: now, error: null } })
  return count === 1
}

export type SendOutcome =
  | { status: "SENT"; messageId: string }
  /** `stop`: Discord refused the bot's token, so no other post can go either (the run stops) */
  | { status: "FAILED"; error: string; stop?: boolean }
  /** Discord rate-limited the bot past what the client waits; the post goes out on the next run */
  | { status: "SCHEDULED"; error: string }
  /** It wasn't ours to send (another run claimed it, or it isn't due or scheduled) */
  | { status: "SKIPPED"; reason: string }

/**
 * How a send that was tried ended, for its audit entry (written after the send, so the log never says a
 * post went out when it didn't): the summary's start ("Posted in #announcements"), and the status and
 * error to keep. With no outcome, the send stopped with an error
 */
export function sendOutcomeAudit(outcome: SendOutcome | undefined, channel: string): { summary: string; status: string; error: string | null } {
  switch (outcome?.status) {
    case "SENT":
      return { summary: `Posted in #${channel}`, status: "SENT", error: null }
    case "FAILED":
      return { summary: `Couldn't post in #${channel} (Discord refused it or didn't confirm it)`, status: "FAILED", error: outcome.error }
    case "SCHEDULED":
      return { summary: `Queued a Discord post for #${channel} (rate-limited; it goes out on a later run)`, status: "SCHEDULED", error: outcome.error }
    case "SKIPPED":
      return { summary: `Queued a Discord post for #${channel} (not confirmed sent yet)`, status: "WAITING", error: outcome.reason }
    default:
      return { summary: `Queued a Discord post for #${channel} (the send stopped with an error)`, status: "UNKNOWN", error: null }
  }
}

/** Why Discord refused a send, in words officers can act on */
export function describeSendError(error: unknown, channel = "the channel"): string {
  if (error instanceof DiscordApiError) {
    if (error.code === DISCORD_ERROR.missingAccess) return `The bot can't see ${channel} (Discord: Missing Access). Check the channel's permissions for the bot.`
    if (error.code === DISCORD_ERROR.missingPermissions) return `The bot isn't allowed to post in ${channel} (Discord: Missing Permissions).`
    if (error.code === DISCORD_ERROR.unknownChannel) return `${channel} no longer exists in Discord.`
    if (error.code === 50035 || error.code === 50006) return `Discord refused the message (${error.message}).`
    if (error.status === 401) return "Discord refused the bot's token. Check DISCORD_BOT_TOKEN on Connections."
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

async function markSent(id: string, messageId: string, at: Date): Promise<SendOutcome> {
  await prisma.discordPost.updateMany({ where: { id, status: "SENDING" }, data: { status: "SENT", sentAt: at, discordMessageId: messageId, error: null } })
  return { status: "SENT", messageId }
}

async function markFailed(id: string, error: string): Promise<Extract<SendOutcome, { status: "FAILED" }>> {
  const text = stored(error)
  await prisma.discordPost.updateMany({ where: { id, status: "SENDING" }, data: { status: "FAILED", error: text } })
  return { status: "FAILED", error: text }
}

/** Whether a message in the channel is this post (the bot's own, with the same text, poll and first embed) */
export function samePost(message: DiscordMessage & { embeds?: DiscordEmbed[] }, body: DiscordMessageBody): boolean {
  if (!message.author?.bot) return false
  if ((message.content ?? "") !== (body.content ?? "")) return false
  if (body.poll && message.poll?.question.text !== body.poll.question.text) return false
  if (body.embeds?.length && message.embeds?.[0]?.title !== body.embeds[0].title) return false
  return true
}

export type SendDeps = { signal?: AbortSignal; pause?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => Date }

/**
 * For a send whose answer never came: is the post in the channel? Reads the messages after the claim
 * (less a minute). Found: SENT. Not found: FAILED, for an officer to check and retry; it's never
 * re-sent blind, because the message could have been posted and then deleted
 */
export async function confirmFromHistory(post: Pick<DiscordPost, "id" | "channelId" | "content" | "claimedAt">, writer: DiscordWriter, cause: unknown, deps: SendDeps = {}): Promise<SendOutcome> {
  const body = readBody(post.content)
  const now = deps.now?.() ?? new Date()
  const since = new Date((post.claimedAt ?? now).getTime() - 60_000)
  const why = describeSendError(cause)
  try {
    const recent = (await writer.messagesAfter(post.channelId, snowflakeAt(since), deps.signal)) as (DiscordMessage & { embeds?: DiscordEmbed[] })[]
    const found = body ? recent.find((m) => samePost(m, body)) : undefined
    if (found) return markSent(post.id, found.id, new Date(found.timestamp))
    return markFailed(post.id, `Discord didn't confirm the send (${why}), and the message isn't in the channel. Check the channel, then retry it from Announcements.`)
  } catch (error) {
    return markFailed(post.id, `Discord didn't confirm the send (${why}), and the channel couldn't be read to check (${describeSendError(error)}). Check the channel before retrying it from Announcements.`)
  }
}

/**
 * Sends a post this caller has claimed (it's SENDING). A 4xx refusal fails it (nothing was posted); a
 * longer rate limit puts it back for the next run; a send with no answer is tried again with the same
 * nonce, then checked against the channel
 */
export async function deliverClaimed(post: DiscordPost, writer: DiscordWriter, deps: SendDeps = {}): Promise<SendOutcome> {
  const body = readBody(post.content)
  if (!body) return markFailed(post.id, "The saved message is unreadable.")
  const problems = messageProblems(body)
  if (problems.length) return markFailed(post.id, problems.join(" "))
  const pause = deps.pause ?? sleep
  const nonce = post.nonce ?? postNonce(post.id)
  let cause: unknown = null
  for (let attempt = 0; attempt < SEND_TRIES; attempt++) {
    try {
      const message = await writer.createMessage(post.channelId, body, nonce, deps.signal)
      return markSent(post.id, message.id, deps.now?.() ?? new Date())
    } catch (error) {
      if (error instanceof DiscordRateLimitError) {
        const text = stored(`Discord rate-limited the bot (${Math.ceil(error.retryAfterMs / 1000)} s); it goes out on the next run.`)
        await prisma.discordPost.updateMany({ where: { id: post.id, status: "SENDING" }, data: { status: "SCHEDULED", claimedAt: null, error: text } })
        return { status: "SCHEDULED", error: text }
      }
      // Discord answered and refused it: nothing was posted. A 2xx whose answer couldn't be read may have posted it, so that one is checked like a send with no answer
      if (error instanceof DiscordApiError && error.status >= 400 && error.status < 500) {
        const failed = await markFailed(post.id, describeSendError(error))
        return error.status === 401 ? { ...failed, stop: true } : failed
      }
      cause = error
      if (deps.signal?.aborted || attempt === SEND_TRIES - 1) break
      await pause(RETRY_PAUSES_MS[attempt] ?? 3_000, deps.signal).catch(() => {})
    }
  }
  // Out of time mid-send: it stays SENDING, and a later run checks the channel for it (sendDuePosts)
  if (deps.signal?.aborted) return { status: "SKIPPED", reason: "The run ran out of time while sending; the next run checks the channel for it." }
  return confirmFromHistory(post, writer, cause, deps)
}

/** Claims and sends one post now (an Apply, an officer's post): the outcome, or why it wasn't sent here */
export async function sendPostNow(id: string, writer: DiscordWriter, deps: SendDeps = {}): Promise<SendOutcome> {
  const now = deps.now?.() ?? new Date()
  if (!(await claimPost(id, now))) {
    const post = await prisma.discordPost.findUnique({ where: { id }, select: { status: true, discordMessageId: true, error: true } })
    if (post?.status === "SENT" && post.discordMessageId) return { status: "SENT", messageId: post.discordMessageId }
    return { status: "SKIPPED", reason: post ? `It's ${post.status.toLowerCase()}${post.error ? ` (${post.error})` : ""}.` : "It no longer exists." }
  }
  const post = await prisma.discordPost.findUniqueOrThrow({ where: { id } })
  return deliverClaimed(post, writer, deps)
}

/** A post's Discord link, once it's sent */
export function postUrl(post: Pick<DiscordPost, "channelId" | "discordMessageId">, guildId = process.env.DISCORD_GUILD_ID?.trim()): string | null {
  return post.discordMessageId && guildId ? discordMessageUrl(guildId, post.channelId, post.discordMessageId) : null
}

/**
 * Cancels scheduled posts. `release` frees their dedupe keys, so the same thing can be posted again when
 * it comes back (an event moved back, a rule switched on again); an officer's cancel or a missed time
 * keeps the key, so a rule never posts it after all
 */
export async function cancelPosts(where: Prisma.DiscordPostWhereInput, reason: string, { release }: { release: boolean }): Promise<number> {
  const { count } = await prisma.discordPost.updateMany({
    where: { AND: [where, { status: "SCHEDULED" }] },
    data: { status: "CANCELLED", error: stored(reason), ...(release ? { dedupeKey: null } : {}) },
  })
  return count
}

/** A reason to cancel a due post instead of sending it (its rule was paused, its event moved), or null to send it */
export type PostCheck = (post: DiscordPost, now: Date) => Promise<string | null>

export type OutboxRun = { sent: number; failed: number; cancelled: number; deferred: number; confirmed: number; links: string[] }

/**
 * The posts job: checks posts a stopped run left SENDING, cancels ones too late to send, then sends what's
 * due (oldest first, at most MAX_SENDS_PER_RUN), each checked first
 */
export async function sendDuePosts(writer: DiscordWriter, ctx: { now: Date; deadline: number; signal?: AbortSignal; log: (line: string) => void; check: PostCheck; pause?: SendDeps["pause"] }): Promise<OutboxRun> {
  const run: OutboxRun = { sent: 0, failed: 0, cancelled: 0, deferred: 0, confirmed: 0, links: [] }
  const deps: SendDeps = { signal: ctx.signal, pause: ctx.pause }
  const timeLeft = () => ctx.deadline - Date.now() > 8_000 && !ctx.signal?.aborted

  const stuck = await prisma.discordPost.findMany({ where: { status: "SENDING", claimedAt: { lt: new Date(ctx.now.getTime() - STUCK_AFTER_MS) } }, orderBy: { claimedAt: "asc" }, take: MAX_SENDS_PER_RUN })
  for (const post of stuck) {
    if (!timeLeft()) break
    const outcome = await confirmFromHistory(post, writer, new Error("the run sending it stopped before Discord answered"), deps)
    if (outcome.status === "SENT") run.confirmed++
    else run.failed++
    ctx.log(outcome.status === "SENT" ? `A post left sending was in the channel after all (marked sent).` : `A post left sending isn't in the channel: marked failed for an officer to check.`)
  }

  const late = await prisma.discordPost.findMany({ where: { status: "SCHEDULED", scheduledFor: { lt: new Date(ctx.now.getTime() - LATE_LIMIT_MS) } }, select: { id: true, scheduledFor: true } })
  for (const post of late) run.cancelled += await cancelPosts({ id: post.id }, `Too late to send: it was due ${when(post.scheduledFor)} (Discord was off, or the scheduler wasn't running).`, { release: false })
  if (late.length) ctx.log(`Cancelled ${late.length} post${late.length === 1 ? "" : "s"} more than 6 hours late.`)

  const due = await prisma.discordPost.findMany({ where: { status: "SCHEDULED", scheduledFor: { lte: ctx.now } }, orderBy: { scheduledFor: "asc" }, take: MAX_SENDS_PER_RUN })
  for (const post of due) {
    if (!timeLeft()) break
    const reason = await ctx.check(post, ctx.now)
    if (reason) {
      run.cancelled += await cancelPosts({ id: post.id }, reason, { release: true })
      ctx.log(`Cancelled a post: ${reason}`)
      continue
    }
    if (!(await claimPost(post.id, ctx.now))) continue
    const outcome = await deliverClaimed({ ...post, status: "SENDING", claimedAt: ctx.now }, writer, deps)
    if (outcome.status === "SENT") {
      run.sent++
      const url = postUrl({ channelId: post.channelId, discordMessageId: outcome.messageId })
      if (url) run.links.push(url)
    } else if (outcome.status === "FAILED") {
      run.failed++
      ctx.log(`A post failed: ${outcome.error}`)
      // A refused token fails every send: the rest wait, and the run fails so Jobs and Connections show it
      if (outcome.stop) throw new Error(`${outcome.error} Sent ${run.sent} before that; the other due posts wait.`)
    } else if (outcome.status === "SCHEDULED") run.deferred++
  }
  return run
}
