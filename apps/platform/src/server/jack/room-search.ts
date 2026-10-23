import type { JackRoomSummary } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { EVAL_ROOM_PREFIX } from "./eval-support"
import { jackRoomSummarySelect, toRoomSummary } from "./messages"
import { roomMessageHref } from "./search/links"
import { searchRoomMessages, type RoomMessageKind } from "./search/sources/rooms"

/**
 * The search box on the rooms list (design §13): rooms whose name matches, and messages that match,
 * each linking to the message in its room with the messages around it. Officers see every message
 * here, Jack's answers included (unlike Jack's own search, which leaves those out unless asked).
 * Archived rooms are in it too, marked: they open read-only.
 */

export const ROOM_SEARCH_MAX = 200
const ROOM_MATCHES = 20
const MESSAGE_MATCHES = 30

/** A message that matched, as the rooms list shows it. Plain JSON for the page */
export type RoomSearchMessage = {
  id: string
  roomId: string
  roomTitle: string
  kind: RoomMessageKind
  author: string
  createdAt: string
  snippet: string
  href: string
  /** In an archived room (it opens read-only) */
  roomArchived: boolean
}

export type RoomSearchResult = { query: string; rooms: JackRoomSummary[]; messages: RoomSearchMessage[] }

/** What was typed in the search box, trimmed and capped; null for nothing */
export function roomSearchQuery(raw: string | string[] | undefined): string | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, ROOM_SEARCH_MAX)
  return value || null
}

export async function searchRooms(query: string): Promise<RoomSearchResult> {
  const [rooms, messages] = await Promise.all([
    prisma.jackRoom.findMany({
      // Rooms in use first, then archived ones
      where: { title: { contains: query, mode: "insensitive" }, NOT: { id: { startsWith: EVAL_ROOM_PREFIX } } },
      orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { updatedAt: "desc" }],
      take: ROOM_MATCHES,
      select: jackRoomSummarySelect,
    }),
    searchRoomMessages({ query, limit: MESSAGE_MATCHES, kinds: ["user", "system", "assistant"], includeArchived: true }),
  ])
  const roomIds = [...new Set(messages.map((hit) => hit.roomId))]
  const archived = roomIds.length
    ? new Set((await prisma.jackRoom.findMany({ where: { id: { in: roomIds }, archivedAt: { not: null } }, select: { id: true } })).map((room) => room.id))
    : new Set<string>()
  return {
    query,
    rooms: rooms.map(toRoomSummary),
    messages: messages.map((hit) => ({
      id: hit.id,
      roomId: hit.roomId,
      roomTitle: hit.roomTitle,
      kind: hit.kind,
      author: hit.author,
      createdAt: hit.createdAt.toISOString(),
      snippet: hit.snippet,
      href: roomMessageHref(hit.roomId, hit.id),
      roomArchived: archived.has(hit.roomId),
    })),
  }
}
