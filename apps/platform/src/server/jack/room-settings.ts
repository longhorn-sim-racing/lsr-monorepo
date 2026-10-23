import { mentionNames, type JackAnswerMode } from "@/lib/jack/mentions"
import { JACK_EVENT, type JackMessageView, type JackRoomView } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { broadcastRoomEvent, type RoomBroadcaster } from "./broadcast"
import { jackMessageInclude, jackRoomViewSelect, toMessageView, toRoomView } from "./messages"

/**
 * A room's own settings from Jack 2.0 (design §10): archiving, pinning and mention mode. Each change is
 * one conditional update, so two officers clicking at once change it (and post its note) once. Every
 * open copy of the room hears it live (room.updated).
 */

type Officer = { id: string; displayName: string }

export type RoomSettingChange =
  | { changed: true; room: JackRoomView; message: JackMessageView | null }
  | { changed: false; room: JackRoomView }

export const ROOM_GONE = "That room doesn't exist anymore."
export const ROOM_ARCHIVED = "This room is archived. Unarchive it to continue."

/** Why a room took no post or change, for the officer: it's gone, or it's archived (read-only until someone unarchives it) */
export async function unavailableMessage(roomId: string): Promise<string> {
  const room = await prisma.jackRoom.findUnique({ where: { id: roomId }, select: { archivedAt: true } })
  return room?.archivedAt ? ROOM_ARCHIVED : ROOM_GONE
}

/**
 * Archives a room or brings it back, and posts a note saying who did it. An archived room is read-only:
 * no posts, no setting changes, and no Jack run starts there (the reply loop finds nothing waiting in it).
 * A reply already streaming finishes. Archiving keeps the pin, for when it comes back. Null when the room
 * doesn't exist.
 */
export async function setRoomArchived(roomId: string, officer: Officer, archived: boolean, broadcast: RoomBroadcaster = broadcastRoomEvent): Promise<RoomSettingChange | null> {
  const exists = await prisma.jackRoom.findUnique({ where: { id: roomId }, select: { id: true } })
  if (!exists) return null

  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.jackRoom.updateMany({
      where: { id: roomId, archivedAt: archived ? null : { not: null } },
      data: { archivedAt: archived ? new Date() : null },
    })
    const room = await tx.jackRoom.findUniqueOrThrow({ where: { id: roomId }, select: jackRoomViewSelect })
    if (!count) return { changed: false as const, room }
    const note = await tx.jackMessage.create({
      data: { roomId, kind: "system", authorUserId: officer.id, content: `${officer.displayName} ${archived ? "archived" : "unarchived"} this room` },
      include: jackMessageInclude,
    })
    return { changed: true as const, room, note }
  })
  return announce(roomId, result, broadcast)
}

/**
 * Pins a room so it sorts first in the rooms list and the rail, or unpins it. Pins are shared, like the
 * rooms. No note: it changes where the room sits, not what's in it. Null when the room doesn't exist or
 * is archived.
 */
export async function setRoomPinned(roomId: string, pinned: boolean, broadcast: RoomBroadcaster = broadcastRoomEvent): Promise<RoomSettingChange | null> {
  const exists = await prisma.jackRoom.findFirst({ where: { id: roomId, archivedAt: null }, select: { id: true } })
  if (!exists) return null

  const { count } = await prisma.jackRoom.updateMany({
    where: { id: roomId, archivedAt: null, pinnedAt: pinned ? null : { not: null } },
    data: { pinnedAt: pinned ? new Date() : null },
  })
  const room = await prisma.jackRoom.findUniqueOrThrow({ where: { id: roomId }, select: jackRoomViewSelect })
  return announce(roomId, count ? { changed: true, room, note: null } : { changed: false, room }, broadcast)
}

/** "answer only messages that mention @Jack" (or "@Lift or @Jack" in a Lift room) */
export function answerModeLabel(mode: JackAnswerMode, persona: JackRoomView["persona"]): string {
  if (mode === "always") return "answer every message"
  return `answer only messages that mention ${mentionNames(persona)
    .reverse()
    .map((name) => `@${name}`)
    .join(" or ")}`
}

/**
 * Switches a room between answering every message and answering only messages that mention Jack (or the
 * persona answering there), and posts a note saying who did it. Messages already posted keep what they
 * were. Null when the room doesn't exist or is archived.
 */
export async function setRoomAnswerMode(roomId: string, officer: Officer, mode: JackAnswerMode, broadcast: RoomBroadcaster = broadcastRoomEvent): Promise<RoomSettingChange | null> {
  const exists = await prisma.jackRoom.findFirst({ where: { id: roomId, archivedAt: null }, select: { id: true } })
  if (!exists) return null

  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.jackRoom.updateMany({ where: { id: roomId, archivedAt: null, answerMode: { not: mode } }, data: { answerMode: mode } })
    const room = await tx.jackRoom.findUniqueOrThrow({ where: { id: roomId }, select: jackRoomViewSelect })
    if (!count) return { changed: false as const, room }
    const note = await tx.jackMessage.create({
      data: { roomId, kind: "system", authorUserId: officer.id, content: `${officer.displayName} set this room to ${answerModeLabel(mode, room.persona)}` },
      include: jackMessageInclude,
    })
    return { changed: true as const, room, note }
  })
  return announce(roomId, result, broadcast)
}

type Saved =
  | { changed: true; room: Parameters<typeof toRoomView>[0]; note: Parameters<typeof toMessageView>[0] | null }
  | { changed: false; room: Parameters<typeof toRoomView>[0] }

/** Tells the room's viewers: the new settings, then the note */
async function announce(roomId: string, saved: Saved, broadcast: RoomBroadcaster): Promise<RoomSettingChange> {
  const room = toRoomView(saved.room)
  if (!saved.changed) return { changed: false, room }
  const message = saved.note ? toMessageView(saved.note) : null
  await broadcast(roomId, { type: JACK_EVENT.room, room })
  if (message) await broadcast(roomId, { type: JACK_EVENT.created, message })
  return { changed: true, room, message }
}
