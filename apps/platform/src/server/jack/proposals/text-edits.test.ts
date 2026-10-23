import { describe, expect, it } from "vitest"
import { applyTextEdits, textEditsSchema } from "./text-edits"

const body = "# LSC rules\n\nRaces start at 7 PM.\nPractice starts at 6 PM.\n"

describe("applyTextEdits", () => {
  it("replaces each exact match, in order", () => {
    expect(applyTextEdits(body, [{ find: "7 PM", replace: "8 PM" }])).toEqual({ text: body.replace("7 PM", "8 PM") })
    // A later edit sees the text as the earlier ones left it
    expect(applyTextEdits(body, [{ find: "7 PM", replace: "9 PM" }, { find: "at 9 PM.", replace: "at 9:30 PM." }])).toEqual({ text: body.replace("7 PM", "9:30 PM") })
  })

  it("refuses a find that isn't there, saying which edit", () => {
    const result = applyTextEdits(body, [{ find: "7 PM", replace: "8 PM" }, { find: "Qualifying", replace: "Quali" }], "the page's text")
    expect(result).toEqual({ error: expect.stringMatching(/^Edit 2: the find text isn't in the page's text/) })
  })

  it("refuses an ambiguous find instead of guessing", () => {
    const result = applyTextEdits(body, [{ find: " PM.", replace: " PM sharp." }])
    expect(result).toEqual({ error: expect.stringMatching(/^The edit: the find text appears 2 times/) })
  })

  it("is all or none: an edit that fails leaves nothing applied", () => {
    const result = applyTextEdits(body, [{ find: "7 PM", replace: "8 PM" }, { find: "nope", replace: "x" }])
    expect("text" in result).toBe(false)
  })

  it("refuses empty and no-op edits", () => {
    expect(applyTextEdits(body, [{ find: "", replace: "x" }])).toEqual({ error: expect.stringMatching(/find can't be empty/) })
    expect(applyTextEdits(body, [{ find: "7 PM", replace: "7 PM" }])).toEqual({ error: expect.stringMatching(/find and replace are the same/) })
  })

  it("keeps replacement text exactly as written ($ patterns included)", () => {
    expect(applyTextEdits("Fee: X", [{ find: "X", replace: "$& $1 $$10" }])).toEqual({ text: "Fee: $& $1 $$10" })
  })
})

describe("textEditsSchema", () => {
  it("takes 1 to 30 edits", () => {
    expect(textEditsSchema.safeParse([]).success).toBe(false)
    expect(textEditsSchema.safeParse([{ find: "a", replace: "b" }]).success).toBe(true)
    expect(textEditsSchema.safeParse(Array.from({ length: 31 }, () => ({ find: "a", replace: "b" }))).success).toBe(false)
  })
})
