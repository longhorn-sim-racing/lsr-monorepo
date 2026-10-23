import { describe, expect, it } from "vitest"
import { describeLineChanges, diffHunks, diffStats, lineDiff } from "./line-diff"

const text = (lines: string[]) => lines.join("\n")

describe("lineDiff", () => {
  it("marks the lines an edit changed, keeping the rest", () => {
    const before = text(["# Rules", "", "Races start at 7 PM.", "Bring a wheel.", "Have fun."])
    const after = text(["# Rules", "", "Races start at 8 PM.", "Bring a wheel.", "Have fun."])
    expect(lineDiff(before, after)).toEqual([
      { op: "same", text: "# Rules" },
      { op: "same", text: "" },
      { op: "del", text: "Races start at 7 PM." },
      { op: "add", text: "Races start at 8 PM." },
      { op: "same", text: "Bring a wheel." },
      { op: "same", text: "Have fun." },
    ])
  })

  it("finds added and removed lines in the middle, not just a block swap", () => {
    const lines = lineDiff(text(["a", "b", "c", "d"]), text(["a", "x", "b", "d"]))
    expect(lines).toEqual([
      { op: "same", text: "a" },
      { op: "add", text: "x" },
      { op: "same", text: "b" },
      { op: "del", text: "c" },
      { op: "same", text: "d" },
    ])
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 })
  })

  it("handles empty texts and Windows line endings", () => {
    expect(lineDiff("", "one")).toEqual([
      { op: "del", text: "" },
      { op: "add", text: "one" },
    ])
    expect(lineDiff("a\r\nb", "a\nb")).toEqual([
      { op: "same", text: "a" },
      { op: "same", text: "b" },
    ])
  })

  it("falls back to all-removed, all-added when the changed part is too big to match line by line", () => {
    const before = Array.from({ length: 2_000 }, (_, i) => `old ${i}`)
    const after = Array.from({ length: 2_000 }, (_, i) => `new ${i}`)
    const lines = lineDiff(text(["same", ...before, "end"]), text(["same", ...after, "end"]))
    expect(lines).toHaveLength(4_002)
    expect(lines[1]).toEqual({ op: "del", text: "old 0" })
    expect(lines[2_001]).toEqual({ op: "add", text: "new 0" })
    expect(diffStats(lines)).toEqual({ added: 2_000, removed: 2_000 })
  })
})

describe("diffHunks", () => {
  it("keeps a little context around changes and collapses long unchanged runs", () => {
    const before = text(Array.from({ length: 20 }, (_, i) => `line ${i}`))
    const after = before.replace("line 10", "LINE 10")
    expect(diffHunks(lineDiff(before, after), 2)).toEqual([
      { op: "skip", count: 8 },
      { op: "same", text: "line 8" },
      { op: "same", text: "line 9" },
      { op: "del", text: "line 10" },
      { op: "add", text: "LINE 10" },
      { op: "same", text: "line 11" },
      { op: "same", text: "line 12" },
      { op: "skip", count: 7 },
    ])
  })

  it("shows nothing but a skip when nothing changed", () => {
    expect(diffHunks(lineDiff("a\nb", "a\nb"))).toEqual([{ op: "skip", count: 2 }])
  })
})

describe("describeLineChanges", () => {
  it("says what changed in plain words", () => {
    expect(describeLineChanges({ added: 1, removed: 1 })).toBe("1 line changed")
    expect(describeLineChanges({ added: 3, removed: 1 })).toBe("1 line changed, 2 added")
    expect(describeLineChanges({ added: 0, removed: 2 })).toBe("2 lines removed")
    expect(describeLineChanges({ added: 4, removed: 0 })).toBe("4 lines added")
    expect(describeLineChanges({ added: 0, removed: 0 })).toBe("No change")
  })
})
