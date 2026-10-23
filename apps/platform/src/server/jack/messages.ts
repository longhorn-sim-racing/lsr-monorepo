import type { JackRoom, Prisma } from "@prisma/client"
import type { JackAuthor, JackMessageView, JackRoomView } from "@/lib/jack/types"
import { parseToolParts } from "@/lib/jack/parts"
import { jackFileItemSelect, toFileItem } from "./files/views"

/**
 * Officer messages carry their author's name, so everyone in the room (and later the model) knows who
 * said what, and their picture for the room
 */
export const jackMessageInclude = {
  author: { select: { displayName: true, avatarUrl: true } },
  // Files an officer attached (G5); only READY files can be posted
  files: { where: { status: "READY" }, orderBy: { position: "asc" }, select: jackFileItemSelect },
} satisfies Prisma.JackMessageInclude

export type JackMessageRow = Prisma.JackMessageGetPayload<{ include: typeof jackMessageInclude }>

/** Shown for an officer message whose author has since deleted their account */
export const FORMER_OFFICER = "Former officer"

function authorOf(row: JackMessageRow): JackAuthor {
  if (row.kind === "assistant") return { kind: "assistant", persona: row.persona ?? "jack" }
  if (row.kind === "system") return { kind: "system" }
  return { kind: "user", userId: row.authorUserId, displayName: row.author?.displayName ?? FORMER_OFFICER, avatarUrl: row.author?.avatarUrl ?? null }
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
    answered: row.kind === "user" || row.continues ? row.answeredById !== null : true,
    ...(row.continues ? { continues: true } : {}),
    ...(row.files?.length ? { files: row.files.map(toFileItem) } : {}),
    createdAt: row.createdAt.toISOString(),
  }
}

export const jackRoomViewSelect = { id: true, title: true, persona: true, updatedAt: true } satisfies Prisma.JackRoomSelect

export function toRoomView(room: Pick<JackRoom, "id" | "title" | "persona" | "updatedAt">): JackRoomView {
  return { id: room.id, title: room.title, persona: room.persona, updatedAt: room.updatedAt.toISOString() }
}
