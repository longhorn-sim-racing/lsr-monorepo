import type { JackRoom, Prisma } from "@prisma/client"
import type { JackAuthor, JackMessageView, JackRoomSummary, JackRoomView } from "@/lib/jack/types"
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
  return {
    kind: "user",
    userId: row.authorUserId,
    displayName: row.author?.displayName ?? FORMER_OFFICER,
    avatarUrl: row.author?.avatarUrl ?? null,
    ...(row.author && row.authorLabel ? { label: row.authorLabel } : {}),
  }
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
    // Mention mode: an officer message that didn't mention Jack (design §10)
    ...(row.kind === "user" && row.expectsAnswer === false ? { expectsAnswer: false as const } : {}),
    ...(row.files?.length ? { files: row.files.map(toFileItem) } : {}),
    createdAt: row.createdAt.toISOString(),
  }
}

export const jackRoomViewSelect = { id: true, title: true, persona: true, updatedAt: true, pinnedAt: true, answerMode: true, archivedAt: true } satisfies Prisma.JackRoomSelect

/** A room as the rooms list, the rail and the list's search show it */
export const jackRoomSummarySelect = {
  id: true,
  title: true,
  persona: true,
  createdAt: true,
  updatedAt: true,
  pinnedAt: true,
  archivedAt: true,
  createdBy: { select: { displayName: true } },
} satisfies Prisma.JackRoomSelect

export function toRoomSummary(room: Prisma.JackRoomGetPayload<{ select: typeof jackRoomSummarySelect }>): JackRoomSummary {
  return {
    id: room.id,
    title: room.title,
    persona: room.persona,
    createdByName: room.createdBy?.displayName ?? null,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
    pinnedAt: room.pinnedAt?.toISOString() ?? null,
    archivedAt: room.archivedAt?.toISOString() ?? null,
  }
}

/** A room's settings for its page. The pin, answer mode and archive date are Jack 2.0's (design §10) */
export function toRoomView(room: Pick<JackRoom, "id" | "title" | "persona" | "updatedAt"> & Partial<Pick<JackRoom, "pinnedAt" | "answerMode" | "archivedAt">>): JackRoomView {
  return {
    id: room.id,
    title: room.title,
    persona: room.persona,
    updatedAt: room.updatedAt.toISOString(),
    pinnedAt: room.pinnedAt?.toISOString() ?? null,
    answerMode: room.answerMode === "mention" ? "mention" : "always",
    archivedAt: room.archivedAt?.toISOString() ?? null,
  }
}
