import type { JackToolPart } from "./parts"

export type ReplyPiece = { kind: "text"; text: string; key: string } | { kind: "part"; part: JackToolPart; key: string }

/**
 * A reply as the room draws it: its text cut at each tool call's `at` (the characters written before
 * the call), with the call in between. Pieces are trimmed; an `at` past the text so far (a part that
 * arrived before its text) sits at the end.
 */
export function replyPieces(content: string, parts: JackToolPart[]): ReplyPiece[] {
  const pieces: ReplyPiece[] = []
  let cursor = 0
  const pushText = (end: number) => {
    const text = content.slice(cursor, end).trim()
    if (text) pieces.push({ kind: "text", text, key: `text-${cursor}` })
    cursor = end
  }
  for (const part of [...parts].sort((a, b) => a.at - b.at)) {
    pushText(Math.min(Math.max(part.at, cursor), content.length))
    pieces.push({ kind: "part", part, key: `part-${part.id}` })
  }
  pushText(content.length)
  return pieces
}
