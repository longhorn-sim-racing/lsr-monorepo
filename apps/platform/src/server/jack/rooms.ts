import type { JackMessageView, JackRoomPersonaKey, JackRoomSummary, JackRoomView } from "@/lib/jack/types"
import { JACK_EVENT, JACK_PERSONA_NAME } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { runAfterResponse } from "@/server/after-response"
import { broadcastRoomEvent, type RoomBroadcaster } from "./broadcast"
import { jackMessageInclude, jackRoomViewSelect, toMessageView, toRoomView } from "./messages"
import { defaultReplyDeps, runRoom, type ReplyLoopDeps } from "./reply-loop"

/** How much of a room a snapshot loads: the latest messages */
const SNAPSHOT_LIMIT = 500

export async function listRooms(): Promise<JackRoomSummary[]> {
  const rooms = await prisma.jackRoom.findMany({
    where: { archivedAt: null },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      id: true,
      title: true,
      persona: true,
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { displayName: true } },
    },
  })
  return rooms.map((room) => ({
    id: room.id,
    title: room.title,
    persona: room.persona,
    createdByName: room.createdBy?.displayName ?? null,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
  }))
}

export async function createRoom(createdById: string, title: string | null) {
  return prisma.jackRoom.create({ data: { createdById, title } })
}

export type RoomSnapshot = {
  room: JackRoomView
  /** Oldest first, including a reply still streaming (its text as last saved, with `streamSeq`) */
  messages: JackMessageView[]
}

export async function getRoomSnapshot(roomId: string): Promise<RoomSnapshot | null> {
  const room = await prisma.jackRoom.findFirst({ where: { id: roomId, archivedAt: null }, select: jackRoomViewSelect })
  if (!room) return null
  const latest = await prisma.jackMessage.findMany({
    where: { roomId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SNAPSHOT_LIMIT,
    include: jackMessageInclude,
  })
  return { room: toRoomView(room), messages: latest.reverse().map(toMessageView) }
}

/**
 * Saves an officer's message, then (after the response) shows it to the room and gets the room's
 * persona answering: if a run is already going, it picks this message up on its next pass.
 * Null when the room doesn't exist or is archived. `replyDeps` is for checks that swap in a fake Claude.
 */
export async function postOfficerMessage(
  roomId: string,
  authorUserId: string,
  content: string,
  replyDeps: ReplyLoopDeps = defaultReplyDeps
): Promise<JackMessageView | null> {
  const room = await prisma.jackRoom.findFirst({ where: { id: roomId, archivedAt: null }, select: { id: true } })
  if (!room) return null

  const [row] = await prisma.$transaction([
    prisma.jackMessage.create({ data: { roomId, kind: "user", authorUserId, content }, include: jackMessageInclude }),
    prisma.jackRoom.update({ where: { id: roomId }, data: { updatedAt: new Date() } }),
  ])
  const message = toMessageView(row)

  await runAfterResponse(async () => {
    await replyDeps.broadcast(roomId, { type: JACK_EVENT.created, message })
    await runRoom(roomId, replyDeps)
  }, `[jack] Answering room ${roomId} failed:`)

  return message
}

/**
 * Starts a run in a room (after the response), for when messages sit unanswered: a run that ran out
 * of time and let go, or one that died. Runs as usual: if a live run holds the room it does nothing,
 * and a dead run's lock is taken over once it's stale, closing its half-written reply. False when the
 * room doesn't exist or is archived.
 */
export async function resumeRoom(roomId: string, replyDeps: ReplyLoopDeps = defaultReplyDeps): Promise<boolean> {
  const room = await prisma.jackRoom.findFirst({ where: { id: roomId, archivedAt: null }, select: { id: true } })
  if (!room) return false
  await runAfterResponse(() => runRoom(roomId, replyDeps), `[jack] Continuing room ${roomId} failed:`)
  return true
}

export type PersonaSwitch =
  | { changed: true; before: JackRoomPersonaKey; room: JackRoomView; message: JackMessageView }
  | { changed: false; room: JackRoomView }

/**
 * Switches which model answers in a room and posts a note saying who did it, e.g. "Alex switched
 * this room to Lift". The next reply uses the new persona; one already streaming finishes as it
 * started. Switching to the persona it already has changes nothing. Null when the room is gone.
 */
export async function setRoomPersona(
  roomId: string,
  officer: { id: string; displayName: string },
  persona: JackRoomPersonaKey,
  broadcast: RoomBroadcaster = broadcastRoomEvent
): Promise<PersonaSwitch | null> {
  const before = await prisma.jackRoom.findFirst({ where: { id: roomId, archivedAt: null }, select: jackRoomViewSelect })
  if (!before) return null

  const result = await prisma.$transaction(async (tx) => {
    // Conditional, so two officers clicking at once post one note, not two
    const { count } = await tx.jackRoom.updateMany({ where: { id: roomId, persona: { not: persona } }, data: { persona } })
    const room = await tx.jackRoom.findUniqueOrThrow({ where: { id: roomId }, select: jackRoomViewSelect })
    if (!count) return { changed: false as const, room }
    const note = await tx.jackMessage.create({
      data: {
        roomId,
        kind: "system",
        authorUserId: officer.id,
        content: `${officer.displayName} switched this room to ${JACK_PERSONA_NAME[persona]}`,
      },
      include: jackMessageInclude,
    })
    return { changed: true as const, room, note }
  })

  const room = toRoomView(result.room)
  if (!result.changed) return { changed: false, room }

  const message = toMessageView(result.note)
  await broadcast(roomId, { type: JACK_EVENT.room, room })
  await broadcast(roomId, { type: JACK_EVENT.created, message })
  return { changed: true, before: before.persona, room, message }
}
