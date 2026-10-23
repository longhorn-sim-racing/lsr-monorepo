import { prisma } from "@/server/db"
import { defaultReplyDeps, runRoom } from "@/server/jack/reply-loop"
import { isRoomLockHeld } from "@/server/jack/room-lock"

/**
 * Getting a scheduled note answered (design §11.1). The job that posted it runs the room, as any post
 * does; when another run holds the room (an officer's question being answered), that run picks the note
 * up after its current reply, so the job doesn't wait: it tries again a few minutes later, and keeps
 * trying for a while (RETRY_WINDOW_MS). A note still waiting after that stays in the room, which offers
 * officers to continue, like an unanswered message.
 */

/** How long after finding the room busy the job looks again */
export const RETRY_AFTER_MS = 3 * 60_000
/** How long after its note was posted the job keeps looking again */
export const RETRY_WINDOW_MS = 45 * 60_000

export type RunRoom = (roomId: string, options: { startedAt: number }) => Promise<void>

export const defaultRunRoom: RunRoom = (roomId, { startedAt }) => runRoom(roomId, defaultReplyDeps, { startedAt })

/** The answer to a note, once a reply has picked it up */
export type NoteAnswer = { id: string; status: string; costUsd: number | null }

export type AnswerOutcome = { answer: NoteAnswer } | { answer: null; busy: boolean }

async function answerOf(noteId: string): Promise<NoteAnswer | null> {
  const note = await prisma.jackMessage.findUnique({ where: { id: noteId }, select: { answeredBy: { select: { id: true, status: true, costUsd: true } } } })
  const reply = note?.answeredBy
  return reply ? { id: reply.id, status: reply.status, costUsd: reply.costUsd === null ? null : Number(reply.costUsd) } : null
}

/**
 * Runs the note's room unless another run holds it, then says whether the note has its answer (a reply
 * may still be streaming it) or is still waiting, and whether the room is busy
 */
export async function answerScheduledNote(note: { id: string; roomId: string }, startedAt: number, run: RunRoom = defaultRunRoom): Promise<AnswerOutcome> {
  const already = await answerOf(note.id)
  if (already) return { answer: already }
  const room = await prisma.jackRoom.findUnique({ where: { id: note.roomId }, select: { runId: true, runStartedAt: true } })
  if (!room) return { answer: null, busy: false }
  if (!isRoomLockHeld(room)) await run(note.roomId, { startedAt })
  const answer = await answerOf(note.id)
  if (answer) return { answer }
  const after = await prisma.jackRoom.findUnique({ where: { id: note.roomId }, select: { runId: true, runStartedAt: true } })
  return { answer: null, busy: Boolean(after && isRoomLockHeld(after)) }
}

/**
 * Moves the job's next run up to `at` (a retry), unless it already runs sooner or was switched off. The
 * claim that started this run already set the next scheduled time; the run after the retry sets it again
 */
export async function retryJobAt(jobId: string, at: Date): Promise<boolean> {
  const { count } = await prisma.scheduledJob.updateMany({ where: { id: jobId, enabled: true, nextRunAt: { gt: at } }, data: { nextRunAt: at } })
  return count === 1
}
