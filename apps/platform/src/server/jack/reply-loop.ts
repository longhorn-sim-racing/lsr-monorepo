import { randomUUID } from "node:crypto"
import { JACK_EVENT } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { broadcastRoomEvent, type RoomBroadcaster } from "./broadcast"
import { DeltaStream } from "./delta-stream"
import { FORMER_OFFICER, jackMessageInclude, toMessageView, type JackMessageRow } from "./messages"
import { releaseRoomLock, renewRoomLock, tryAcquireRoomLock } from "./room-lock"

export type ReplyLoopDeps = {
  broadcast: RoomBroadcaster
  /** Paces the placeholder reply; tests skip the wait */
  sleep: (ms: number) => Promise<void>
}

const defaultDeps: ReplyLoopDeps = {
  broadcast: broadcastRoomEvent,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** The placeholder reply takes about this long to stream, so viewers can watch it arrive */
const PLACEHOLDER_STREAM_MS = 3_000

/** Officer messages Jack hasn't answered yet, oldest first */
function findUnanswered(roomId: string) {
  return prisma.jackMessage.findMany({
    where: { roomId, persona: null, answeredById: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: jackMessageInclude,
  })
}

async function hasUnanswered(roomId: string) {
  const first = await prisma.jackMessage.findFirst({
    where: { roomId, persona: null, answeredById: null },
    select: { id: true },
  })
  return first !== null
}

/**
 * Answers a room until nothing in it is left unanswered, unless another run already is. Runs on the
 * server, independent of any browser tab (posting starts it after the response).
 *
 * Each pass answers every officer message that's waiting, together in one reply, so messages posted
 * mid-answer are picked up by the next pass. When nothing is waiting the run lets go of the lock,
 * then looks once more: a message posted just before that found the lock taken and left it to this
 * run, so if one is there the run takes the lock back (or sees that a newer run has it). That way
 * nothing is ever left unanswered.
 */
export async function runRoom(roomId: string, deps: ReplyLoopDeps = defaultDeps): Promise<void> {
  const runId = randomUUID()
  if (!(await tryAcquireRoomLock(roomId, runId))) return
  let holding = true
  try {
    await closeInterruptedReplies(roomId, deps)
    for (;;) {
      const waiting = await findUnanswered(roomId)
      if (waiting.length) {
        if (!(await renewRoomLock(roomId, runId))) {
          holding = false // a newer run took over a lock it thought was stale; it answers from here
          return
        }
        await answer(roomId, waiting, deps)
        continue
      }

      await releaseRoomLock(roomId, runId)
      holding = false
      if (!(await hasUnanswered(roomId))) return
      if (!(await tryAcquireRoomLock(roomId, runId))) return // another run has it and will answer
      holding = true
    }
  } finally {
    if (holding) await releaseRoomLock(roomId, runId).catch((error) => console.error("[jack] Couldn't release the room lock:", error))
  }
}

/**
 * Replies still marked streaming when a run takes the lock belong to a run that died (one run per
 * room), so close them as errors and tell the room.
 */
async function closeInterruptedReplies(roomId: string, deps: ReplyLoopDeps) {
  const stuck = await prisma.jackMessage.findMany({ where: { roomId, status: "streaming" }, select: { id: true } })
  for (const { id } of stuck) {
    const closed = await prisma.jackMessage.update({ where: { id }, data: { status: "error" }, include: jackMessageInclude })
    await deps.broadcast(roomId, { type: JACK_EVENT.done, message: toMessageView(closed) })
  }
}

/** One reply to every message in `waiting` */
async function answer(roomId: string, waiting: JackMessageRow[], deps: ReplyLoopDeps) {
  const reply = await prisma.$transaction(async (tx) => {
    const created = await tx.jackMessage.create({
      data: { roomId, persona: "jack", status: "streaming" },
      include: jackMessageInclude,
    })
    await tx.jackMessage.updateMany({
      where: { id: { in: waiting.map((m) => m.id) }, answeredById: null },
      data: { answeredById: created.id },
    })
    return created
  })
  await deps.broadcast(roomId, { type: JACK_EVENT.created, message: toMessageView(reply) })

  const stream = new DeltaStream({
    roomId,
    messageId: reply.id,
    broadcast: deps.broadcast,
    persist: async (content, streamSeq) => {
      await prisma.jackMessage.update({ where: { id: reply.id }, data: { content, streamSeq } })
    },
  })

  let status: "done" | "error" = "done"
  let result: { content: string; streamSeq: number }
  try {
    const pieces = chunkForStreaming(placeholderReply(waiting))
    const pause = Math.max(10, Math.round(PLACEHOLDER_STREAM_MS / pieces.length))
    for (const piece of pieces) {
      stream.write(piece)
      await deps.sleep(pause)
    }
    result = await stream.end()
  } catch (error) {
    console.error(`[jack] Reply ${reply.id} in room ${roomId} failed:`, error)
    status = "error"
    result = stream.abort()
  }

  let final: JackMessageRow
  try {
    final = await prisma.jackMessage.update({
      where: { id: reply.id },
      data: { content: result.content, streamSeq: result.streamSeq, status },
      include: jackMessageInclude,
    })
  } catch (error) {
    // Viewers still get the ending; the next run closes the row as interrupted
    console.error(`[jack] Couldn't save reply ${reply.id}:`, error)
    final = { ...reply, ...result, status: "error" }
  }
  await deps.broadcast(roomId, { type: JACK_EVENT.done, message: toMessageView(final) })
}

/** What Jack says until he has a model behind him: the question(s), with who asked */
export function placeholderReply(waiting: Pick<JackMessageRow, "content" | "author">[]): string {
  const asked = waiting.map((m) => `${m.author?.displayName ?? FORMER_OFFICER}: ${m.content}`).join("\n")
  return `Jack here (placeholder, no AI yet). You asked:\n${asked}`
}

/** Splits text into at most `maxPieces` runs of whole words, in order (joined back, they're the text) */
export function chunkForStreaming(text: string, maxPieces = 60): string[] {
  const words = text.match(/\s*\S+\s*/g) ?? [text]
  const perPiece = Math.ceil(words.length / maxPieces)
  const pieces: string[] = []
  for (let i = 0; i < words.length; i += perPiece) pieces.push(words.slice(i, i + perPiece).join(""))
  return pieces
}
