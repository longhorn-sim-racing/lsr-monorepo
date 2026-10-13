import type { Prisma } from "@prisma/client"
import type { JackMessageView } from "@/lib/jack/types"

/** Officer messages carry their author's name, so everyone in the room (and later the model) knows who said what */
export const jackMessageInclude = {
  author: { select: { displayName: true } },
} satisfies Prisma.JackMessageInclude

export type JackMessageRow = Prisma.JackMessageGetPayload<{ include: typeof jackMessageInclude }>

/** Shown for an officer message whose author has since deleted their account */
export const FORMER_OFFICER = "Former officer"

export function toMessageView(row: JackMessageRow): JackMessageView {
  return {
    id: row.id,
    roomId: row.roomId,
    author: row.persona
      ? { kind: "persona", persona: row.persona }
      : { kind: "officer", userId: row.authorUserId, displayName: row.author?.displayName ?? FORMER_OFFICER },
    content: row.content,
    status: row.status,
    streamSeq: row.streamSeq,
    createdAt: row.createdAt.toISOString(),
  }
}
