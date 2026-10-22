import { describe, expect, it } from "vitest"
import { parseInline, parseReply, safeHref, type MdInline } from "./reply-markdown"

const text = (t: string): MdInline => ({ kind: "text", text: t })
const strong = (...children: MdInline[]): MdInline => ({ kind: "strong", children })
const em = (...children: MdInline[]): MdInline => ({ kind: "em", children })
const link = (href: string, label = href): MdInline => ({ kind: "link", href, children: [text(label)] })

describe("parseInline", () => {
  it("leaves plain text alone, line breaks included", () => {
    expect(parseInline("Three entries so far.\nTwo are paid.")).toEqual([text("Three entries so far.\nTwo are paid.")])
  })

  it("reads bold and italics, nested", () => {
    expect(parseInline("**Slide 2:** the *GM 2* date")).toEqual([strong(text("Slide 2:")), text(" the "), em(text("GM 2")), text(" date")])
    expect(parseInline("__Date:__ Sat, Oct 31")).toEqual([strong(text("Date:")), text(" Sat, Oct 31")])
    expect(parseInline("*a **b** c*")).toEqual([em(text("a "), strong(text("b")), text(" c"))])
  })

  it("doesn't treat snake_case, math or lone marks as formatting", () => {
    expect(parseInline("league_access and entry_fee_cents")).toEqual([text("league_access and entry_fee_cents")])
    expect(parseInline("$10 * 12 = $120, rated 4 * 5")).toEqual([text("$10 * 12 = $120, rated 4 * 5")])
    expect(parseInline("an unclosed **mark")).toEqual([text("an unclosed **mark")])
    expect(parseInline("\\*not italics\\*")).toEqual([text("*not italics*")])
  })

  it("keeps marks inside code as written", () => {
    expect(parseInline("run `SELECT **` now")).toEqual([text("run "), { kind: "code", text: "SELECT **" }, text(" now")])
  })

  it("links Markdown links, bare links and site paths, without trailing punctuation", () => {
    expect(parseInline("[Open the deck](/admin/jack/decks/d1)")).toEqual([link("/admin/jack/decks/d1", "Open the deck")])
    expect(parseInline("See https://longhornsimracing.org/lsc.")).toEqual([text("See "), link("https://longhornsimracing.org/lsc"), text(".")])
    expect(parseInline("Deck: /admin/jack/decks/d1, 5 slides")).toEqual([text("Deck: "), link("/admin/jack/decks/d1"), text(", 5 slides")])
    expect(parseInline("(https://example.com/a_(b))")).toEqual([text("("), link("https://example.com/a_(b)"), text(")")])
  })

  it("doesn't link 10/19, and/or or unsafe schemes", () => {
    expect(parseInline("on 10/19 and/or later")).toEqual([text("on 10/19 and/or later")])
    expect(parseInline("[click](javascript:alert(1))")).toEqual([text("[click](javascript:alert(1))")])
    expect(parseInline("[click](javascript:void)")).toEqual([text("click")])
  })

  it("never puts a link inside a link", () => {
    expect(parseInline("[https://example.com](https://example.com)")).toEqual([link("https://example.com")])
  })

  describe("while streaming", () => {
    it("bolds an unclosed mark at the end instead of showing it", () => {
      expect(parseInline("Here is **Slide 2", true)).toEqual([text("Here is "), strong(text("Slide 2"))])
      expect(parseInline("Here is **Slide 2*", true)).toEqual([text("Here is "), strong(text("Slide 2"))])
    })

    it("holds back a mark with nothing after it yet", () => {
      expect(parseInline("Here is **", true)).toEqual([text("Here is ")])
      expect(parseInline("league_", true)).toEqual([text("league")])
    })

    it("shows a link's label while its address streams in", () => {
      expect(parseInline("[Open the deck](/admin/ja", true)).toEqual([text("Open the deck")])
      expect(parseInline("see [Open", true)).toEqual([text("see "), text("Open")])
    })
  })
})

describe("parseReply", () => {
  it("splits paragraphs on blank lines", () => {
    expect(parseReply("First.\n\nSecond.")).toEqual([
      { kind: "paragraph", children: [text("First.")] },
      { kind: "paragraph", children: [text("Second.")] },
    ])
  })

  it("reads bullet and numbered lists, nested by indent", () => {
    expect(parseReply("Upcoming:\n- GM 2\n  - Mon, Oct 26\n- LSC Round 3\n\n3. third\n4. fourth")).toEqual([
      { kind: "paragraph", children: [text("Upcoming:")] },
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          { children: [text("GM 2")], lists: [{ kind: "list", ordered: false, start: 1, items: [{ children: [text("Mon, Oct 26")], lists: [] }] }] },
          { children: [text("LSC Round 3")], lists: [] },
        ],
      },
      {
        kind: "list",
        ordered: true,
        start: 3,
        items: [
          { children: [text("third")], lists: [] },
          { children: [text("fourth")], lists: [] },
        ],
      },
    ])
  })

  it("ends a list at an unindented line, and continues an item on an indented one", () => {
    expect(parseReply("- one\n  more of one\nWant the details?")).toEqual([
      { kind: "list", ordered: false, start: 1, items: [{ children: [text("one\nmore of one")], lists: [] }] },
      { kind: "paragraph", children: [text("Want the details?")] },
    ])
  })

  it("reads code blocks, headings and rules", () => {
    expect(parseReply("## Summary\n```sql\nSELECT **\n```\n---")).toEqual([
      { kind: "heading", children: [text("Summary")] },
      { kind: "code", text: "SELECT **" },
      { kind: "rule" },
    ])
  })

  it("keeps a line of only bold text a paragraph, not a list or rule", () => {
    expect(parseReply("**Date:** Sat, Oct 31")).toEqual([{ kind: "paragraph", children: [strong(text("Date:")), text(" Sat, Oct 31")] }])
  })

  describe("while streaming", () => {
    it("holds back a half-typed list marker on the last line", () => {
      expect(parseReply("Upcoming:\n-", true)).toEqual([{ kind: "paragraph", children: [text("Upcoming:")] }])
      expect(parseReply("Upcoming:\n2.", true)).toEqual([{ kind: "paragraph", children: [text("Upcoming:")] }])
    })

    it("leaves marks open only in the text at the very end", () => {
      expect(parseReply("an unclosed **mark\n\n- item **one", true)).toEqual([
        { kind: "paragraph", children: [text("an unclosed **mark")] },
        { kind: "list", ordered: false, start: 1, items: [{ children: [text("item "), strong(text("one"))], lists: [] }] },
      ])
    })

    it("shows an unclosed code block as it streams", () => {
      expect(parseReply("```\nSELECT 1", true)).toEqual([{ kind: "code", text: "SELECT 1" }])
    })
  })
})

describe("safeHref", () => {
  it("allows web, email and site links only", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com")
    expect(safeHref("mailto:officers@example.com")).toBe("mailto:officers@example.com")
    expect(safeHref("/admin/events")).toBe("/admin/events")
    expect(safeHref("//evil.example")).toBeNull()
    expect(safeHref("javascript:alert(1)")).toBeNull()
    expect(safeHref("data:text/html,hi")).toBeNull()
  })
})
