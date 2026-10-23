import { randomBytes } from "node:crypto"
import { Prisma } from "@prisma/client"
import { redactSecrets } from "@/lib/redact"
import type { DiscordClient } from "@/server/connectors/discord/client"
import { prisma } from "@/server/db"

/**
 * Sends the digest's Discord copy (design §11.2, §12.1 Posting). The discord-post track owns posting to
 * Discord; until its posting function lands, the digest sends through the same pieces it builds on: a
 * DiscordPost row (its content is exactly what's sent), T7's REST client (rate limits, timeout, errors
 * without the token), and Discord's own guards:
 *
 * - One post per digest: the row's `dedupeKey` ("digest:<day>") is unique, so a second run that day finds
 *   the first one's row and sends nothing more once it's SENT.
 * - A SENDING claim: the row is created as SENDING, or taken over from FAILED (or from a SENDING claim
 *   older than SENDING_STALE_MS, a run that died) with a conditional update, so two runs never both send.
 * - `nonce` + `enforce_nonce`: a retry of the same row reuses its nonce, so Discord returns the message it
 *   already made instead of posting it twice (within Discord's nonce window).
 * - `allowed_mentions: { parse: [] }`: the copy pings nobody, whatever its text.
 * Failures are kept on the row (status FAILED, error redacted) and thrown to the job.
 */

/** DiscordPost.source for the weekly digest */
export const DIGEST_POST_SOURCE = "digest"

/** A SENDING claim older than this is from a run that died, and another run may take it over */
export const SENDING_STALE_MS = 10 * 60_000

export type DiscordMessageBody = { content: string; allowed_mentions: { parse: string[] }; flags?: number }

export type DiscordSendOutcome = { status: "sent"; messageId: string; postId: string } | { status: "already_sent"; messageId: string | null; postId: string } | { status: "busy"; postId: string }

/** A nonce Discord accepts (25 characters at most) */
export function newNonce(): string {
  return randomBytes(12).toString("hex")
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

/** Claims the day's row for sending: a new row, or the existing one when it failed or its claim went stale */
async function claim(input: { channelId: string; body: DiscordMessageBody; dedupeKey: string; createdById: string | null }, now: Date): Promise<{ id: string; nonce: string } | DiscordSendOutcome> {
  const content = input.body as unknown as Prisma.InputJsonValue
  try {
    const row = await prisma.discordPost.create({
      data: {
        source: DIGEST_POST_SOURCE,
        channelId: input.channelId,
        content,
        dedupeKey: input.dedupeKey,
        nonce: newNonce(),
        status: "SENDING",
        scheduledFor: now,
        claimedAt: now,
        createdById: input.createdById,
        approvedById: input.createdById,
      },
      select: { id: true, nonce: true },
    })
    return { id: row.id, nonce: row.nonce! }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
  const existing = await prisma.discordPost.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true, status: true, nonce: true, discordMessageId: true } })
  if (!existing) throw new Error("The digest's Discord post vanished while it was being claimed")
  if (existing.status === "SENT") return { status: "already_sent", messageId: existing.discordMessageId, postId: existing.id }
  const nonce = existing.nonce ?? newNonce()
  const { count } = await prisma.discordPost.updateMany({
    where: {
      id: existing.id,
      OR: [{ status: { in: ["SCHEDULED", "FAILED"] } }, { status: "SENDING", claimedAt: { lt: new Date(now.getTime() - SENDING_STALE_MS) } }],
    },
    data: { status: "SENDING", claimedAt: now, channelId: input.channelId, content, nonce, error: null },
  })
  return count ? { id: existing.id, nonce } : { status: "busy", postId: existing.id }
}

/** Sends the digest's message to a channel, once per `dedupeKey` */
export async function sendDigestToDiscord(
  input: { channelId: string; body: DiscordMessageBody; dedupeKey: string; createdById: string | null },
  client: DiscordClient,
  { now = new Date(), signal }: { now?: Date; signal?: AbortSignal } = {},
): Promise<DiscordSendOutcome> {
  const claimed = await claim(input, now)
  if ("status" in claimed) return claimed
  try {
    const { data } = await client.rest.request<{ id: string }>("POST", `/channels/${encodeURIComponent(input.channelId)}/messages`, {
      body: { ...input.body, allowed_mentions: { parse: [] }, nonce: claimed.nonce, enforce_nonce: true },
      signal,
    })
    await prisma.discordPost.update({ where: { id: claimed.id }, data: { status: "SENT", sentAt: new Date(), discordMessageId: data.id, error: null } })
    return { status: "sent", messageId: data.id, postId: claimed.id }
  } catch (error) {
    const text = redactSecrets(error instanceof Error ? error.message : String(error), { maxLength: 500 })
    await prisma.discordPost.update({ where: { id: claimed.id }, data: { status: "FAILED", error: text } }).catch((failure) => console.error("[digest] Couldn't record the failed Discord post:", failure))
    throw error
  }
}
