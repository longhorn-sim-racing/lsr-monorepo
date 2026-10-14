import { describe, expect, it } from "vitest"
import type { JackToolPart } from "./parts"
import { replyPieces } from "./reply-pieces"

const part = (id: string, at: number): JackToolPart => ({ id, name: "run_sql", label: "Ran a query", status: "done", at, input: null, displays: [] })

describe("replyPieces", () => {
  it("cuts the text at each tool call, in order", () => {
    const text = "Let me check.\n\nThere are 13.\n\nAnd 4 paid."
    const pieces = replyPieces(text, [part("b", text.indexOf("\n\nAnd")), part("a", "Let me check.".length)])

    expect(pieces.map((p) => (p.kind === "text" ? p.text : `[${p.part.id}]`))).toEqual(["Let me check.", "[a]", "There are 13.", "[b]", "And 4 paid."])
  })

  it("handles calls at the very start, together, and past the text so far", () => {
    const pieces = replyPieces("Counting", [part("a", 0), part("b", 0), part("c", 99)])

    expect(pieces.map((p) => (p.kind === "text" ? p.text : `[${p.part.id}]`))).toEqual(["[a]", "[b]", "Counting", "[c]"])
  })

  it("is just the text without tool calls, and nothing for an empty reply", () => {
    expect(replyPieces("Hello", [])).toEqual([{ kind: "text", text: "Hello", key: "text-0" }])
    expect(replyPieces("", [])).toEqual([])
  })
})
