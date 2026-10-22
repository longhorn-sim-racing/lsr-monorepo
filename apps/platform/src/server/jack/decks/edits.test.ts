import { describe, expect, it } from "vitest"
import type { JackDeckContent } from "@/lib/jack/decks"
import { applyEdits, applyOrder, applyWrites } from "./edits"

let n = 0
const id = () => `new${++n}`

function deck(...htmls: string[]): JackDeckContent {
  return { css: ".a{color:red}", slides: htmls.map((html, i) => ({ id: `s${i + 1}`, html })) }
}

describe("applyWrites", () => {
  it("appends slides one past the end, in order", () => {
    n = 0
    const result = applyWrites(deck(), [{ slide: 1, html: "<section>1</section>" }, { slide: 2, html: "<section>2</section>", notes: "  say hi  " }], undefined, id)
    expect(result).toEqual({
      content: { css: ".a{color:red}", slides: [{ id: "new1", html: "<section>1</section>" }, { id: "new2", html: "<section>2</section>", notes: "say hi" }] },
      touched: ["new1", "new2"],
      cssChanged: false,
    })
  })

  it("replaces a slide's html or notes and keeps its id", () => {
    const result = applyWrites(deck("<a>", "<b>"), [{ slide: 2, html: "<B>" }, { slide: 1, notes: "Notes" }], undefined, id)
    expect("content" in result && result.content.slides).toEqual([{ id: "s1", html: "<a>", notes: "Notes" }, { id: "s2", html: "<B>" }])
    expect("touched" in result && result.touched).toEqual(["s2", "s1"])
  })

  it("inserts before an existing slide when asked", () => {
    n = 0
    const result = applyWrites(deck("<a>", "<b>"), [{ slide: 1, html: "<new>", insert: true }], undefined, id)
    expect("content" in result && result.content.slides.map((s) => s.html)).toEqual(["<new>", "<a>", "<b>"])
  })

  it("counts each write against the deck as the earlier writes left it", () => {
    n = 0
    const result = applyWrites(deck("<a>"), [{ slide: 2, html: "<b>" }, { slide: 3, html: "<c>" }, { slide: 2, html: "<B>" }], undefined, id)
    expect("content" in result && result.content.slides.map((s) => s.html)).toEqual(["<a>", "<B>", "<c>"])
  })

  it("replaces the deck CSS and says so", () => {
    const result = applyWrites(deck("<a>"), [], ".b{}", id)
    expect(result).toMatchObject({ content: { css: ".b{}" }, cssChanged: true, touched: [] })
  })

  it("explains bad numbers and missing html", () => {
    expect(applyWrites(deck("<a>"), [{ slide: 3, html: "<c>" }], undefined, id)).toEqual({ error: "Slide write 1 (slide 3): the deck has 1 slides. Use slide 2 to add one at the end." })
    expect(applyWrites(deck("<a>"), [{ slide: 2 }], undefined, id)).toEqual({ error: "Slide write 1 (slide 2): a new slide needs its html." })
    expect(applyWrites(deck("<a>"), [{ slide: 1 }], undefined, id)).toEqual({ error: "Slide write 1 (slide 1): give the html, the notes, or both." })
    expect(applyWrites(deck("<a>"), [{ slide: 4, html: "<x>", insert: true }], undefined, id)).toMatchObject({ error: expect.stringContaining("can go at 1 to 2") })
  })

  it("doesn't count a slide as touched when nothing about it changed", () => {
    const result = applyWrites(deck("<a>"), [{ slide: 1, html: "<a>" }], undefined, id)
    expect("touched" in result && result.touched).toEqual([])
  })
})

describe("applyEdits", () => {
  it("replaces exactly one match in a slide", () => {
    const result = applyEdits(deck("<p>Old title</p><p>Other</p>"), [{ slide: 1, find: "Old title", replace: "New title" }])
    expect(result).toMatchObject({ content: { slides: [{ id: "s1", html: "<p>New title</p><p>Other</p>" }] }, touched: ["s1"], cssChanged: false })
  })

  it("edits the deck CSS when no slide is given", () => {
    expect(applyEdits(deck("<a>"), [{ find: "red", replace: "#FF8000" }])).toMatchObject({ content: { css: ".a{color:#FF8000}" }, cssChanged: true, touched: [] })
  })

  it("needs the text to be there, and unique unless all is set", () => {
    expect(applyEdits(deck("<p>x</p>"), [{ slide: 1, find: "y", replace: "z" }])).toMatchObject({ error: expect.stringContaining("isn't in slide 1") })
    expect(applyEdits(deck("<p>x</p><p>x</p>"), [{ slide: 1, find: "x", replace: "z" }])).toMatchObject({ error: expect.stringContaining("appears 2 times") })
    expect(applyEdits(deck("<p>x</p><p>x</p>"), [{ slide: 1, find: "x", replace: "z", all: true }])).toMatchObject({ content: { slides: [{ html: "<p>z</p><p>z</p>" }] } })
  })

  it("applies edits in order, all or nothing", () => {
    const start = deck("<p>a</p>")
    expect(applyEdits(start, [{ slide: 1, find: "a", replace: "b" }, { slide: 1, find: "b", replace: "c" }])).toMatchObject({ content: { slides: [{ html: "<p>c</p>" }] } })
    expect(applyEdits(start, [{ slide: 1, find: "a", replace: "b" }, { slide: 2, find: "x", replace: "y" }])).toEqual({ error: "Edit 2 (slide 2): the deck has 1 slides." })
    expect(start.slides[0].html).toBe("<p>a</p>")
  })

  it("edits a slide's notes without touching its picture", () => {
    const start: JackDeckContent = { css: "", slides: [{ id: "s1", html: "<p>x</p>", notes: "Deadline is Nov 2" }] }
    const result = applyEdits(start, [{ slide: 1, notes: true, find: "Nov 2", replace: "Oct 26" }])
    expect(result).toEqual({ content: { css: "", slides: [{ id: "s1", html: "<p>x</p>", notes: "Deadline is Oct 26" }] }, touched: [], cssChanged: false })
    expect(applyEdits(start, [{ notes: true, find: "Nov", replace: "Oct" }])).toMatchObject({ error: expect.stringContaining("say which slide") })
  })

  it("treats $ in the replacement literally", () => {
    expect(applyEdits(deck("<p>FEE</p>"), [{ slide: 1, find: "FEE", replace: "$10 $& $1" }])).toMatchObject({ content: { slides: [{ html: "<p>$10 $& $1</p>" }] } })
  })
})

describe("applyOrder", () => {
  it("reorders", () => {
    const result = applyOrder(deck("<a>", "<b>", "<c>"), [3, 1, 2], id)
    expect(result).toMatchObject({ content: { slides: [{ id: "s3" }, { id: "s1" }, { id: "s2" }] }, summary: "reordered the slides", touched: [] })
  })

  it("deletes slides left out and duplicates ones listed twice", () => {
    n = 0
    const result = applyOrder(deck("<a>", "<b>", "<c>"), [1, 1, 3], id)
    expect(result).toMatchObject({ content: { slides: [{ id: "s1" }, { id: "new1", html: "<a>" }, { id: "s3" }] }, touched: ["new1"], summary: "deleted 1 slide, duplicated 1" })
  })

  it("refuses numbers outside the deck and an empty order", () => {
    expect(applyOrder(deck("<a>"), [2], id)).toEqual({ error: "order has 2, but the deck's slides are 1 to 1." })
    expect(applyOrder(deck("<a>"), [], id)).toMatchObject({ error: expect.stringContaining("at least one slide") })
  })
})
