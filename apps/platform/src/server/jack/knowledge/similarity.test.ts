import { describe, expect, it } from "vitest"
import { duplicateMatch, type LexemeCounts } from "./similarity"

const counts = (overrides: Partial<LexemeCounts>): LexemeCounts => ({ newTitle: 3, newText: 40, oldTitle: 3, oldText: 40, sharedTitle: 0, sharedText: 0, ...overrides })

describe("duplicateMatch", () => {
  it("flags the same or nearly the same title", () => {
    expect(duplicateMatch(counts({ sharedTitle: 3 }))).toEqual({ score: 1, reason: "title" })
    // "Dues policy" against "Dues policy for fall": 2 of 3
    expect(duplicateMatch(counts({ newTitle: 2, oldTitle: 3, sharedTitle: 2 }))).toEqual({ score: 0.67, reason: "title" })
    expect(duplicateMatch(counts({ newTitle: 2, oldTitle: 4, sharedTitle: 1 }))).toBeNull()
  })

  it("flags an entry that's mostly inside the other one", () => {
    expect(duplicateMatch(counts({ newText: 10, oldText: 120, sharedText: 8 }))).toEqual({ score: 0.8, reason: "text" })
    // Too few shared words to say: one-line entries share a few common ones by chance
    expect(duplicateMatch(counts({ newText: 4, oldText: 120, sharedText: 4 }))).toBeNull()
  })

  it("flags two texts that are mostly the same", () => {
    expect(duplicateMatch(counts({ newText: 40, oldText: 50, sharedText: 30 }))).toEqual({ score: 0.75, reason: "text" })
    expect(duplicateMatch(counts({ newText: 40, oldText: 50, sharedText: 10 }))).toBeNull()
  })

  it("names the stronger reason when both match", () => {
    expect(duplicateMatch(counts({ sharedTitle: 2, newText: 20, oldText: 20, sharedText: 19 }))).toEqual({ score: 0.95, reason: "text" })
    expect(duplicateMatch(counts({ sharedTitle: 3, newText: 20, oldText: 20, sharedText: 15 }))).toEqual({ score: 1, reason: "title" })
  })

  it("never matches empty sets", () => {
    expect(duplicateMatch({ newTitle: 0, newText: 0, oldTitle: 0, oldText: 0, sharedTitle: 0, sharedText: 0 })).toBeNull()
  })
})
