import { describe, expect, it } from "vitest"
import { findPassages, outlineOf, pageOf, queryTerms } from "./paging"

describe("pageOf", () => {
  const text = "First paragraph here.\n\nSecond paragraph, a bit longer than the first.\n\nThird."

  it("returns the whole text when it fits, with no next page", () => {
    expect(pageOf(text, 0, 1_000)).toEqual({ text, offset: 0, nextOffset: null, total: text.length })
  })

  it("ends a page at a paragraph break near the limit and says where the next one starts", () => {
    const page = pageOf(text, 0, 26)
    expect(page.text).toBe("First paragraph here.\n\n")
    expect(page.nextOffset).toBe(23)
    const next = pageOf(text, page.nextOffset!, 1_000)
    expect(next.text.startsWith("Second paragraph")).toBe(true)
    expect(next.nextOffset).toBeNull()
  })

  it("pages through a long text without losing or repeating a character", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"word ".repeat(i % 7)}`).join("\n")
    let offset: number | null = 0
    let rebuilt = ""
    let pages = 0
    while (offset !== null) {
      const page = pageOf(long, offset, 500)
      expect(page.text.length).toBeLessThanOrEqual(500)
      rebuilt += page.text
      offset = page.nextOffset
      pages++
    }
    expect(rebuilt).toBe(long)
    expect(pages).toBeGreaterThan(5)
  })

  it("cuts hard when there's no break, but never inside an emoji", () => {
    const solid = "x".repeat(9) + "😀" + "y".repeat(20)
    const page = pageOf(solid, 0, 10)
    expect(page.text).toBe("x".repeat(9))
    expect(pageOf(solid, page.nextOffset!, 2).text).toBe("😀")
  })

  it("returns an empty last page for an offset past the end", () => {
    expect(pageOf(text, 10_000, 100)).toEqual({ text: "", offset: text.length, nextOffset: null, total: text.length })
    expect(pageOf(text, -5, 5).offset).toBe(0)
  })
})

describe("outlineOf", () => {
  it("lists Markdown headings with their level and offset, skipping code blocks", () => {
    const text = "# Rules\nIntro\n## Points\n```\n# not a heading\n```\n### Ties ##\nText"
    const outline = outlineOf(text)
    expect(outline).toEqual([
      { heading: "Rules", level: 1, offset: 0 },
      { heading: "Points", level: 2, offset: 14 },
      { heading: "Ties", level: 3, offset: text.indexOf("### Ties") },
    ])
    expect(text.slice(outline[1].offset).startsWith("## Points")).toBe(true)
  })

  it("stops at the cap", () => {
    const many = Array.from({ length: 60 }, (_, i) => `## Part ${i}`).join("\n")
    expect(outlineOf(many, 10)).toHaveLength(10)
  })
})

describe("findPassages", () => {
  const doc = [
    "# Sponsorship",
    "We met Acme about sponsorships on Tuesday.",
    "The budget for the season is set by the treasurer.",
    "Nothing about money here, just the weather.",
    "Sponsors get a logo on the car and a post on Instagram. The sponsor budget is separate.",
  ].join("\n\n")

  it("returns the paragraphs that match, best first until the limit, then in document order", () => {
    const match = findPassages(doc, "sponsor budget", 1_000)
    expect(match.matched).toBe(4)
    expect(match.passages.map((p) => p.text)).toEqual([
      "# Sponsorship",
      "We met Acme about sponsorships on Tuesday.",
      "The budget for the season is set by the treasurer.",
      "Sponsors get a logo on the car and a post on Instagram. The sponsor budget is separate.",
    ])
    for (const passage of match.passages) expect(doc.slice(passage.offset).startsWith(passage.text)).toBe(true)
  })

  it("keeps the best matches when they don't all fit", () => {
    const match = findPassages(doc, "sponsor budget", 90)
    expect(match.passages.map((p) => p.text)).toEqual(["Sponsors get a logo on the car and a post on Instagram. The sponsor budget is separate."])
    expect(match.matched).toBe(4)
  })

  it("scores a quoted phrase higher, and finds nothing for stop words alone", () => {
    expect(findPassages(doc, '"sponsor budget"', 90).passages.map((p) => p.text)).toEqual([expect.stringContaining("sponsor budget")])
    expect(findPassages(doc, "the and of", 1_000)).toEqual({ passages: [], matched: 0 })
    expect(findPassages(doc, "zeppelin", 1_000).matched).toBe(0)
  })

  it("matches whole words from their start, not inside other words", () => {
    expect(findPassages("Overbudget items.\n\nA budget line.", "budget", 1_000).passages.map((p) => p.text)).toEqual(["A budget line."])
  })

  it("splits a long paragraph into pieces", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Line ${i} ${i === 70 ? "target" : "filler"} text here`).join("\n")
    const match = findPassages(long, "target", 5_000)
    expect(match.passages).toHaveLength(1)
    expect(match.passages[0].text.length).toBeLessThanOrEqual(1_500)
    expect(match.passages[0].text).toContain("Line 70 target")
  })
})

describe("queryTerms", () => {
  it("lowercases, drops stop words, \"or\" and duplicates", () => {
    expect(queryTerms('The "Lone Star" cup OR cup rules -for')).toEqual(["lone", "star", "cup", "rules"])
  })
})
