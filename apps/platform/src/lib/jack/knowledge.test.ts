import { describe, expect, it } from "vitest"
import { applyTextEdits, describeAge, formatAge, knowledgeAge, normalizeTags, parseProvenance, roomMessagePath } from "./knowledge"

const DAY = 86_400_000
const now = new Date("2026-10-22T17:00:00Z")
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY)

describe("normalizeTags", () => {
  it("lowercases, joins words with dashes, drops punctuation and repeats", () => {
    expect(normalizeTags(["Decision", " Who does what ", "LSC!", "decision", "", "  ", "Peña's"])).toEqual(["decision", "who-does-what", "lsc", "penas"])
  })

  it("keeps at most ten, each at most 40 characters", () => {
    expect(normalizeTags(Array.from({ length: 15 }, (_, i) => `tag ${i}`))).toHaveLength(10)
    expect(normalizeTags(["x".repeat(60)])[0]).toHaveLength(40)
  })
})

describe("knowledgeAge", () => {
  it("counts from the review first, then the source date, then the last edit", () => {
    expect(knowledgeAge({ reviewedAt: daysAgo(3), sourceDate: daysAgo(400), updatedAt: daysAgo(1) }, now)).toMatchObject({ days: 3, basis: "reviewed", stale: false })
    expect(knowledgeAge({ reviewedAt: null, sourceDate: daysAgo(200), updatedAt: daysAgo(1) }, now)).toMatchObject({ days: 200, basis: "source", stale: true })
    expect(knowledgeAge({ reviewedAt: null, sourceDate: null, updatedAt: daysAgo(10) }, now)).toMatchObject({ days: 10, basis: "updated", stale: false })
  })

  it("is stale only past 180 days, and never negative", () => {
    expect(knowledgeAge({ reviewedAt: daysAgo(180), sourceDate: null, updatedAt: now }, now).stale).toBe(false)
    expect(knowledgeAge({ reviewedAt: daysAgo(181), sourceDate: null, updatedAt: now }, now).stale).toBe(true)
    expect(knowledgeAge({ reviewedAt: null, sourceDate: new Date(now.getTime() + DAY), updatedAt: now }, now).days).toBe(0)
  })
})

describe("formatAge and describeAge", () => {
  it("say an age the way people do", () => {
    expect([0, 1, 9, 20, 45, 200, 800].map(formatAge)).toEqual(["today", "1 day", "9 days", "2 weeks", "6 weeks", "6 months", "2 years"])
    expect(describeAge(knowledgeAge({ reviewedAt: daysAgo(3), sourceDate: null, updatedAt: now }, now))).toBe("Reviewed 3 days ago")
    expect(describeAge(knowledgeAge({ reviewedAt: null, sourceDate: daysAgo(200), updatedAt: now }, now))).toBe("Source dated 6 months ago")
    expect(describeAge(knowledgeAge({ reviewedAt: null, sourceDate: null, updatedAt: now }, now))).toBe("Last edited today")
  })
})

describe("applyTextEdits", () => {
  const text = "Dues: none this semester.\nLSC entry: $10, or $5 for returning drivers."

  it("applies exact edits in order, all or none", () => {
    expect(applyTextEdits(text, [{ find: "$10", replace: "$12" }, { find: "$12, or", replace: "$12 or" }])).toEqual({
      text: "Dues: none this semester.\nLSC entry: $12 or $5 for returning drivers.",
    })
    // The replacement is literal, even with $& in it
    expect(applyTextEdits("a b", [{ find: "b", replace: "$&$&" }])).toEqual({ text: "a $&$&" })
  })

  it("refuses a find that's missing or appears more than once", () => {
    expect(applyTextEdits(text, [{ find: "$10", replace: "$12" }, { find: "nope", replace: "x" }])).toEqual({ error: expect.stringMatching(/^Edit 2: the find text isn't in the entry/) })
    expect(applyTextEdits(text, [{ find: "e", replace: "E" }])).toEqual({ error: expect.stringMatching(/appears \d+ times/) })
    expect(applyTextEdits(text, [{ find: "", replace: "x" }])).toEqual({ error: "Edit 1: find can't be empty." })
  })
})

describe("parseProvenance", () => {
  it("reads what the knowledge tool saves, and nothing else", () => {
    const saved = {
      roomId: "room-1",
      replyId: "reply-1",
      messageIds: ["m1", 7],
      askedBy: { userId: "u1", name: "Gray" },
      tools: [{ name: "read", input: '{"type":"document"}', label: "Read a document" }, { input: "no name" }, null],
      at: "2026-10-22T17:00:00.000Z",
    }
    expect(parseProvenance(saved)).toEqual({
      roomId: "room-1",
      replyId: "reply-1",
      messageIds: ["m1"],
      askedBy: { userId: "u1", name: "Gray" },
      tools: [{ name: "read", input: '{"type":"document"}', label: "Read a document" }],
      at: "2026-10-22T17:00:00.000Z",
    })
    expect(parseProvenance(null)).toBeNull()
    expect(parseProvenance([])).toBeNull()
    expect(parseProvenance({ roomId: 3 })).toBeNull()
  })
})

describe("roomMessagePath", () => {
  it("anchors the message when there is one", () => {
    expect(roomMessagePath("r1", "m 1")).toBe("/admin/jack/r1?m=m%201")
    expect(roomMessagePath("r1", null)).toBe("/admin/jack/r1")
  })
})
