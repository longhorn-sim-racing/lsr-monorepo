import type { Prisma } from "@prisma/client"
import type { DiscordClient } from "@/server/connectors/discord/client"
import { discordWriter, type DiscordMessageBody } from "@/server/connectors/discord/write"
import { prisma } from "@/server/db"
import { queueDiscordPost, sendPostNow } from "@/server/discord-post/outbox"

export type { DiscordMessageBody }

/**
 * Sends the digest's Discord copy (design §11.2) through Discord posting (discord-post/outbox.ts), so it
 * shows on Announcements with every other post and goes out with the same guards: one claim per send, the
 * post's own nonce with `enforce_nonce`, a send with no answer confirmed from the channel's history, and
 * `allowed_mentions: { parse: [] }` (the copy pings nobody, whatever its text).
 * - One post per digest: its `dedupeKey` ("digest:<day>") is unique, so a second run that day finds the
 *   day's post and sends nothing more once it's SENT.
 * - A post that failed is tried again by the next run, with that run's text; one another run is sending
 *   is left to it, and one Discord rate-limited stays queued for the Discord posts job.
 * Failures are kept on the post (FAILED, redacted) and thrown to the job.
 */

/** DiscordPost.source for the weekly digest */
export const DIGEST_POST_SOURCE = "digest"

export type DiscordSendOutcome = { status: "sent"; messageId: string; postId: string } | { status: "already_sent"; messageId: string | null; postId: string } | { status: "busy"; postId: string }

/** Sends the digest's message to a channel, once per `dedupeKey` */
export async function sendDigestToDiscord(
  input: { channelId: string; body: DiscordMessageBody; dedupeKey: string; createdById: string | null },
  client: DiscordClient,
  { now = new Date(), signal }: { now?: Date; signal?: AbortSignal } = {},
): Promise<DiscordSendOutcome> {
  const body: DiscordMessageBody = { ...input.body, allowed_mentions: { parse: [] } }
  const { post } = await queueDiscordPost({
    source: DIGEST_POST_SOURCE,
    channelId: input.channelId,
    body,
    dedupeKey: input.dedupeKey,
    scheduledFor: now,
    createdById: input.createdById,
    approvedById: input.createdById,
  })
  if (post.status === "SENT") return { status: "already_sent", messageId: post.discordMessageId, postId: post.id }
  if (post.status === "FAILED") {
    // An earlier run's send failed: this run tries again, with its own text and channel
    await prisma.discordPost.updateMany({
      where: { id: post.id, status: "FAILED" },
      data: { status: "SCHEDULED", scheduledFor: now, channelId: input.channelId, content: body as unknown as Prisma.InputJsonValue, error: null },
    })
  }
  const outcome = await sendPostNow(post.id, discordWriter(client.rest, client.guildId), { signal, now: () => now })
  if (outcome.status === "SENT") return { status: "sent", messageId: outcome.messageId, postId: post.id }
  if (outcome.status === "FAILED") throw new Error(outcome.error)
  // Another run has it, it was cancelled on Announcements, or Discord rate-limited it (it stays queued)
  return { status: "busy", postId: post.id }
}
