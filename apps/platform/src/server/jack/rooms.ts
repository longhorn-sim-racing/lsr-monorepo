import type { JackMessageView, JackRoomSummary } from "@/lib/jack/types"
import { JACK_EVENT } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { runAfterResponse } from "@/server/after-response"
import { broadcastRoomEvent } from "./broadcast"
import { jackMessageInclude, toMessageView } from "./messages"
import { runRoom } from "./reply-loop"

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
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { displayName: true } },
    },
  })
  return rooms.map((room) => ({
    id: room.id,
    title: room.title,
    createdByName: room.createdBy?.displayName ?? null,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
  }))
}

export async function createRoom(createdById: string, title: string | null) {
  return prisma.jackRoom.create({ data: { createdById, title } })
}

export type RoomSnapshot = {
  room: { id: string; title: string | null }
  /** Oldest first, including a reply still streaming (its text as last saved, with `streamSeq`) */
  messages: JackMessageView[]
}

export async function getRoomSnapshot(roomId: string): Promise<RoomSnapshot | null> {
  const room = await prisma.jackRoom.findFirst({ where: { id: roomId, archivedAt: null }, select: { id: true, title: true } })
  if (!room) return null
  const latest = await prisma.jackMessage.findMany({
    where: { roomId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SNAPSHOT_LIMIT,
    include: jackMessageInclude,
  })
  return { room, messages: latest.reverse().map(toMessageView) }
}

/**
 * Saves an officer's message, then (after the response) shows it to the room and gets Jack
 * answering: if a run is already going, it picks this message up on its next pass.
 * Null when the room doesn't exist or is archived.
 */
export async function postOfficerMessage(roomId: string, authorUserId: string, content: string): Promise<JackMessageView | null> {
  const room = await prisma.jackRoom.findFirst({ where: { id: roomId, archivedAt: null }, select: { id: true } })
  if (!room) return null

  const [row] = await prisma.$transaction([
    prisma.jackMessage.create({ data: { roomId, authorUserId, content }, include: jackMessageInclude }),
    prisma.jackRoom.update({ where: { id: roomId }, data: { updatedAt: new Date() } }),
  ])
  const message = toMessageView(row)

  await runAfterResponse(async () => {
    await broadcastRoomEvent(roomId, { type: JACK_EVENT.created, message })
    await runRoom(roomId)
  }, `[jack] Answering room ${roomId} failed:`)

  return message
}
