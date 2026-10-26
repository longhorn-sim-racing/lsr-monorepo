import type { Prisma } from "@prisma/client"
import type { DiscordClient } from "@/server/connectors/discord/client"
import { discordWriter, type DiscordMessageBody } from "@/server/connectors/discord/write"
import { prisma } from "@/server/db"
import { postingChannelIds } from "@/server/discord-post/channels"
import { isUnconfirmedFailure, queueDiscordPost, sendPostNow } from "@/server/discord-post/outbox"

export type { DiscordMessageBody }

/**
 * Sends the digest's Discord copy (design §11.2) through Discord posting (discord-post/outbox.ts), so it
 * shows on Announcements with every other post and follows the same rules:
 * - **Posting channels:** its channel must be one of the channels admins allow (channels.ts), the rule
 *   every post is checked against right before it's sent (post-check.ts). It's checked here before
 *   anything is queued, so taking the channel off the list, or clearing the list, stops the digest too.
 * - **One sender:** the post is claimed before it's sent (`sendPostNow`), so of this run and the Discord
 *   posts job only one sends it. One Discord rate-limited goes back to the posts job, which checks it
 *   again before sending.
 * - **Never re-sent blind:** an earlier try today that nothing was posted for (Discord refused it, or
 *   rate-limited it) is sent again with this run's text and channel. One whose send Discord never
 *   confirmed may be in the channel already, so it's left for an officer to look and use Send again on
 *   Announcements.
 * - `allowed_mentions: { parse: [] }`: the copy pings nobody, whatever its text.
 * One post per digest: its `dedupeKey` ("digest:<day>") is unique, so a second run that day finds the
 * day's post. Failures are kept on the post (FAILED, redacted) and thrown to the job.
 */

/** DiscordPost.source for the weekly digest */
export const DIGEST_POST_SOURCE = "digest"

export const NOT_A_POSTING_CHANNEL =
  "Its channel isn't one of the Discord posting channels, so nothing was posted. An admin adds it on Community → Announcements, or picks a posting channel in the digest's settings on Jack → Recurring questions."
export const EARLIER_SEND_UNCONFIRMED =
  "Today's earlier send wasn't confirmed by Discord, so the digest doesn't send it again: it may be in the channel already. Look there, then use Send again on Community → Announcements if it isn't."

export type DiscordSendOutcome =
  | { status: "sent"; messageId: string; postId: string }
  | { status: "already_sent"; messageId: string | null; postId: string }
  /** Not sent by this run: another run is sending it, or Discord rate-limited it and the Discord posts job sends it */
  | { status: "waiting"; postId: string; reason: string }
  /** Cancelled (by an officer on Announcements, or too late to send): nothing goes out today */
  | { status: "cancelled"; postId: string; reason: string }

/** Sends the digest's message to a channel, once per `dedupeKey` */
export async function sendDigestToDiscord(
  input: { channelId: string; body: DiscordMessageBody; dedupeKey: string; createdById: string | null },
  client: DiscordClient,
  { now = new Date(), signal }: { now?: Date; signal?: AbortSignal } = {},
): Promise<DiscordSendOutcome> {
  if (!(await postingChannelIds()).includes(input.channelId)) throw new Error(NOT_A_POSTING_CHANNEL)
  const body: DiscordMessageBody = { ...input.body, allowed_mentions: { parse: [] } }
  const { post, created } = await queueDiscordPost({
    source: DIGEST_POST_SOURCE,
    channelId: input.channelId,
    body,
    dedupeKey: input.dedupeKey,
    scheduledFor: now,
    createdById: input.createdById,
    approvedById: input.createdById,
  })
  if (post.status === "SENT") return { status: "already_sent", messageId: post.discordMessageId, postId: post.id }
  if (post.status === "CANCELLED") return { status: "cancelled", postId: post.id, reason: post.error?.replace(/\.$/, "") || "on Announcements" }
  if (post.status === "SENDING") return { status: "waiting", postId: post.id, reason: "an earlier try is still sending (the Discord posts job checks the channel for it)" }
  if (post.status === "FAILED" && isUnconfirmedFailure(post.error)) throw new Error(EARLIER_SEND_UNCONFIRMED)
  if (!created) {
    // An earlier try today that nothing was posted for: this run's text and channel, due now
    await prisma.discordPost.updateMany({
      where: { id: post.id, status: post.status },
      data: { status: "SCHEDULED", scheduledFor: now, claimedAt: null, channelId: input.channelId, content: body as unknown as Prisma.InputJsonValue, error: null },
    })
  }
  const outcome = await sendPostNow(post.id, discordWriter(client.rest, client.guildId), { signal, now: () => now })
  if (outcome.status === "SENT") return { status: "sent", messageId: outcome.messageId, postId: post.id }
  if (outcome.status === "FAILED") throw new Error(outcome.error)
  if (outcome.status === "SCHEDULED") return { status: "waiting", postId: post.id, reason: "rate-limited, so the Discord posts job sends it" }
  return { status: "waiting", postId: post.id, reason: "the Discord posts job or an officer took it first (see Announcements)" }
}
