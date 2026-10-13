import type { JackRoom, Prisma } from "@prisma/client"
import type { JackAuthor, JackMessageView, JackRoomView } from "@/lib/jack/types"
import { parseToolParts } from "@/lib/jack/parts"

/** Officer messages carry their author's name, so everyone in the room (and later the model) knows who said what */
export const jackMessageInclude = {
  author: { select: { displayName: true } },
} satisfies Prisma.JackMessageInclude

export type JackMessageRow = Prisma.JackMessageGetPayload<{ include: typeof jackMessageInclude }>

/** Shown for an officer message whose author has since deleted their account */
export const FORMER_OFFICER = "Former officer"

function authorOf(row: JackMessageRow): JackAuthor {
  if (row.kind === "assistant") return { kind: "assistant", persona: row.persona ?? "jack" }
  if (row.kind === "system") return { kind: "system" }
  return { kind: "user", userId: row.authorUserId, displayName: row.author?.displayName ?? FORMER_OFFICER }
}

export function toMessageView(row: JackMessageRow): JackMessageView {
  return {
    id: row.id,
    roomId: row.roomId,
    author: authorOf(row),
    content: row.content,
    tools: parseToolParts(row.toolCalls),
    status: row.status,
    streamSeq: row.streamSeq,
    answered: row.kind !== "user" || row.answeredById !== null,
    createdAt: row.createdAt.toISOString(),
  }
}

export const jackRoomViewSelect = { id: true, title: true, persona: true, updatedAt: true } satisfies Prisma.JackRoomSelect

export function toRoomView(room: Pick<JackRoom, "id" | "title" | "persona" | "updatedAt">): JackRoomView {
  return { id: room.id, title: room.title, persona: room.persona, updatedAt: room.updatedAt.toISOString() }
}
