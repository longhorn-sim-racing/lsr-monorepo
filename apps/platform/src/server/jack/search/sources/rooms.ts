import { Prisma } from "@prisma/client"
import { JACK_PERSONA_NAME, jackRoomTitle, type JackPersonaKey } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { ct } from "../../tools/time"
import { roomMessageHref } from "../links"
import { cleanSnippet, HEADLINE_INPUT_CHARS, HEADLINE_OPTIONS, isoOrNull, queryCte, rankOf } from "../sql"
import type { SearchHit, SearchSource } from "../types"

/**
 * Messages in Jack's rooms (design §7.1, §10): what officers wrote and the rooms' notes. Jack's own
 * earlier answers are searched only when asked, and labelled as not a source: an answer is only as
 * good as the data it came from, so it's checked again rather than repeated.
 */

/** How a hit from one of Jack's answers is labelled, for the model and the room */
export const JACK_ANSWER_LABEL = "Jack's earlier answer (not a source)"

export type RoomMessageKind = "user" | "system" | "assistant"

type RoomRow = {
  id: string
  roomId: string
  kind: RoomMessageKind
  persona: JackPersonaKey | null
  createdAt: Date
  roomTitle: string | null
  author: string | null
  rank: number
  snippet: string | null
}

export type RoomMessageHit = {
  id: string
  roomId: string
  roomTitle: string
  kind: RoomMessageKind
  /** The officer, the persona ("Jack"), or "Room note" */
  author: string
  createdAt: Date
  snippet: string
  rank: number
}

/** Who wrote a message, as search shows it */
export function messageAuthor(kind: RoomMessageKind, author: string | null, persona: JackPersonaKey | null): string {
  if (kind === "assistant") return JACK_PERSONA_NAME[persona ?? "jack"]
  if (kind === "system") return "Room note"
  return author ?? "Former officer"
}

/**
 * Full-text search over room messages of the given kinds, best first. Shared by `search` and the
 * rooms list's search box. Room messages are indexed once they've finished streaming. Their text
 * carries weight D in the index (titles elsewhere get A), so it's weighted like other sources' body
 * text to merge fairly.
 */
export async function searchRoomMessages({
  query,
  limit,
  kinds,
  includeArchived = true,
}: {
  query: string
  limit: number
  kinds: RoomMessageKind[]
  /** Messages in archived rooms too (the rooms list leaves them out until archived rooms can be opened) */
  includeArchived?: boolean
}): Promise<RoomMessageHit[]> {
  if (!kinds.length) return []
  const rows = await prisma.$queryRaw<RoomRow[]>(Prisma.sql`
    WITH ${queryCte(query)},
    hits AS (
      SELECT m.id, m."roomId", m.kind::text AS kind, m.persona::text AS persona, m."createdAt", m.content,
        r.title AS "roomTitle", u."displayName" AS author,
        ts_rank_cd('{0.2,0.2,0.4,1.0}', d.search, q.query, 32) AS rank
      FROM "JackSearchDoc" d
      CROSS JOIN q
      JOIN "JackMessage" m ON m.id = d."sourceId"
      JOIN "JackRoom" r ON r.id = m."roomId"
      LEFT JOIN "User" u ON u.id = m."authorUserId"
      WHERE d.source = 'room_message' AND d.search @@ q.query AND m.kind::text IN (${Prisma.join(kinds)})
        ${includeArchived ? Prisma.empty : Prisma.sql`AND r."archivedAt" IS NULL`}
      ORDER BY rank DESC, m."createdAt" DESC
      LIMIT ${limit}
    )
    SELECT h.id, h."roomId", h.kind, h.persona, h."createdAt", h."roomTitle", h.author, h.rank,
      ts_headline('english', left(h.content, ${HEADLINE_INPUT_CHARS}::int), q.query, ${HEADLINE_OPTIONS}) AS snippet
    FROM hits h CROSS JOIN q
    ORDER BY h.rank DESC, h."createdAt" DESC`)
  return rows.map((row) => ({
    id: row.id,
    roomId: row.roomId,
    roomTitle: jackRoomTitle({ title: row.roomTitle }),
    kind: row.kind,
    author: messageAuthor(row.kind, row.author, row.persona),
    createdAt: row.createdAt,
    snippet: cleanSnippet(row.snippet),
    rank: rankOf(row.rank),
  }))
}

function toHit(hit: RoomMessageHit): SearchHit {
  const jack = hit.kind === "assistant"
  return {
    source: "rooms",
    type: "room_message",
    id: hit.id,
    title: jack ? `${JACK_ANSWER_LABEL}, in “${hit.roomTitle}”` : `${hit.author} in “${hit.roomTitle}”`,
    url: roomMessageHref(hit.roomId, hit.id),
    snippet: hit.snippet,
    date: isoOrNull(hit.createdAt),
    meta: { room: hit.roomTitle, by: jack ? JACK_ANSWER_LABEL : hit.author },
    rank: hit.rank,
  }
}

/** Messages shown on each side of the one `read` opens */
const CONTEXT_MESSAGES = 6
/** The most of each neighbouring message `read` shows (the opened one is shown whole) */
const CONTEXT_CHARS = 2_000

const messageSelect = {
  id: true,
  kind: true,
  persona: true,
  content: true,
  status: true,
  createdAt: true,
  author: { select: { displayName: true } },
} satisfies Prisma.JackMessageSelect

type ContextMessage = Prisma.JackMessageGetPayload<{ select: typeof messageSelect }>

/** One message as a transcript line: "Mon 2026-10-19 18:00 CT · Gray: …" */
export function transcriptLine(message: ContextMessage, { opened = false, maxChars = CONTEXT_CHARS } = {}): string {
  const who = message.kind === "assistant" ? `${JACK_PERSONA_NAME[message.persona ?? "jack"]} (${JACK_ANSWER_LABEL})` : messageAuthor(message.kind, message.author?.displayName ?? null, null)
  const text = message.content.length > maxChars ? `${message.content.slice(0, maxChars)}… (${message.content.length - maxChars} more characters: read this message for all of it)` : message.content
  const status = message.status === "error" ? " [stopped early]" : message.status === "streaming" ? " [still being written]" : ""
  return `${opened ? "→ (the message you opened) " : ""}${ct(message.createdAt)} · ${who}${status}: ${text || "(no text)"}`
}

export const roomsSource: SearchSource = {
  key: "rooms",
  description: `messages officers wrote in Jack rooms, and the rooms' notes (proposals applied, renames); with includeJackReplies, also your own earlier answers, labelled "${JACK_ANSWER_LABEL}"`,
  byDefault: true,
  async search({ query, limit, includeJackReplies }) {
    const kinds: RoomMessageKind[] = includeJackReplies ? ["user", "system", "assistant"] : ["user", "system"]
    return (await searchRoomMessages({ query, limit, kinds })).map(toHit)
  },
  readers: [
    {
      type: "room_message",
      description: "a room message with the messages around it, by message id",
      async read(id) {
        const target = await prisma.jackMessage.findUnique({
          where: { id },
          select: { ...messageSelect, roomId: true, room: { select: { title: true } } },
        })
        if (!target) return { ok: false, error: `No room message ${id}. Search for it again: it may have been deleted with its room.` }
        const order = [{ createdAt: "desc" as const }, { id: "desc" as const }]
        const [before, after] = await Promise.all([
          prisma.jackMessage.findMany({
            where: { roomId: target.roomId, OR: [{ createdAt: { lt: target.createdAt } }, { createdAt: target.createdAt, id: { lt: target.id } }] },
            orderBy: order,
            take: CONTEXT_MESSAGES,
            select: messageSelect,
          }),
          prisma.jackMessage.findMany({
            where: { roomId: target.roomId, OR: [{ createdAt: { gt: target.createdAt } }, { createdAt: target.createdAt, id: { gt: target.id } }] },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: CONTEXT_MESSAGES,
            select: messageSelect,
          }),
        ])
        const room = jackRoomTitle({ title: target.room.title })
        const lines = [
          ...before.reverse().map((m) => transcriptLine(m)),
          transcriptLine(target, { opened: true, maxChars: Number.MAX_SAFE_INTEGER }),
          ...after.map((m) => transcriptLine(m)),
        ]
        return {
          ok: true,
          doc: {
            type: "room_message",
            id: target.id,
            title: target.kind === "assistant" ? `${JACK_ANSWER_LABEL}, in “${room}”` : `${messageAuthor(target.kind, target.author?.displayName ?? null, null)} in “${room}”`,
            url: roomMessageHref(target.roomId, target.id),
            date: isoOrNull(target.createdAt),
            meta: { room, messagesAround: before.length + after.length },
            text: `# Room “${room}”\n\n${lines.join("\n\n")}`,
          },
        }
      },
    },
  ],
}
