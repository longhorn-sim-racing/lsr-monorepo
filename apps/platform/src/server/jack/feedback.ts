import { summarizeFeedback, type JackFeedbackRating, type JackFeedbackSummary } from "@/lib/jack/feedback"
import { prisma } from "@/server/db"

/**
 * Officers' thumbs up or down on Jack's replies (#188, design §10): one rating per officer per reply
 * (JackFeedback's unique key), changeable, with an optional short note. The room shows them under each
 * reply; the Usage page counts them and lists thumbs-down, with a note as an eval candidate.
 */

const feedbackRowSelect = { messageId: true, userId: true, rating: true, note: true, user: { select: { displayName: true } } } as const

/** Every reply's ratings in a room, as `viewerId` sees them (their own marked) */
export async function roomFeedback(roomId: string, viewerId: string): Promise<Record<string, JackFeedbackSummary>> {
  const rows = await prisma.jackFeedback.findMany({
    where: { message: { roomId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: feedbackRowSelect,
  })
  return summarizeFeedback(rows, viewerId)
}

export type FeedbackChange =
  | { ok: true; roomId: string; summary: JackFeedbackSummary }
  | { ok: false; error: string }

const EMPTY: JackFeedbackSummary = { up: 0, down: 0, mine: null, raters: [] }

/**
 * Sets an officer's rating of a reply, or takes it back (`rating` null). Replacing a rating replaces its
 * note too, and dates it now (JackFeedback has no separate edit time). Only finished replies in rooms that
 * aren't archived. Returns the reply's ratings as that officer now sees them.
 */
export async function setReplyFeedback({
  messageId,
  userId,
  rating,
  note,
}: {
  messageId: string
  userId: string
  rating: JackFeedbackRating | null
  note: string | null
}): Promise<FeedbackChange> {
  const message = await prisma.jackMessage.findUnique({
    where: { id: messageId },
    select: { roomId: true, kind: true, status: true, room: { select: { archivedAt: true } } },
  })
  if (!message || message.kind !== "assistant") return { ok: false, error: "That reply doesn't exist anymore." }
  if (message.room.archivedAt) return { ok: false, error: "This room is archived. Unarchive it to rate replies." }
  if (message.status === "streaming") return { ok: false, error: "Wait for the reply to finish first." }

  if (rating === null) {
    await prisma.jackFeedback.deleteMany({ where: { messageId, userId } })
  } else {
    await prisma.jackFeedback.upsert({
      where: { messageId_userId: { messageId, userId } },
      create: { messageId, userId, rating, note },
      update: { rating, note, createdAt: new Date() },
    })
  }

  const rows = await prisma.jackFeedback.findMany({ where: { messageId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: feedbackRowSelect })
  return { ok: true, roomId: message.roomId, summary: summarizeFeedback(rows, userId)[messageId] ?? EMPTY }
}
