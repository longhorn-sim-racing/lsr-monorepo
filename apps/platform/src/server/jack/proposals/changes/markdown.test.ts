import { describe, expect, it } from "vitest"
import { markdownPreview, mdxError, mdxProblems } from "./markdown"

const problems = (text: string) => mdxProblems(text).map((p) => `${p.line}:${p.what}`)

describe("mdxProblems: what the site's MDX would run", () => {
  it("passes plain Markdown, GFM included", () => {
    const text = "# LSC Season 3\n\nRaces are **Saturdays** at 7 PM. See [the rules](/lone-star-cup/rules) or https://example.com.\n\n- [x] Sign up\n- Bring a wheel\n\n| Round | Track |\n|---|---|\n| 1 | Spa |\n\n> Quote me\n\n~~old~~ new 5 > 3"
    expect(mdxProblems(text)).toEqual([])
    expect(mdxError(text)).toBeNull()
  })

  it("refuses HTML, components, braces and comments outside code", () => {
    expect(problems("Hello <b>there</b>")).toEqual(["1:<", "1:<"])
    expect(problems("A <Button /> here")).toEqual(["1:<"])
    expect(problems("Total: {1 + 1}")).toEqual(["1:{", "1:}"])
    expect(problems("Just a } brace")).toEqual(["1:}"])
    expect(problems("<!-- hidden -->")).toEqual(["1:<"])
    expect(problems("Link: <https://example.com>")).toEqual(["1:<"])
    expect(problems("Escaped \\{ still counts")).toEqual(["1:{"])
  })

  it("allows them inside code spans and fenced blocks, as MDX does", () => {
    expect(problems("Use `<Button />` or `{x}`")).toEqual([])
    expect(problems("```tsx\nconst x = <b>{y}</b>\n```")).toEqual([])
    expect(problems("~~~\n{ \"json\": true }\n~~~")).toEqual([])
    expect(problems("> ```\n> <x>\n> ```")).toEqual([])
    expect(problems("- item\n\n  ```\n  {a}\n  ```")).toEqual([])
  })

  it("counts indented text as text: MDX has no indented code blocks", () => {
    expect(problems("Para\n\n    <script>alert(1)</script>")).toEqual(["3:<", "3:<"])
  })

  it("follows where a fence really ends: a quote's fence closes with the quote", () => {
    expect(problems("> ```\n> safe {code}\n\n<b>not code</b>")).toEqual(["4:<", "4:<"])
  })

  it("refuses import and export lines, which MDX runs as modules", () => {
    expect(problems('import Thing from "./thing"\n\nText')).toEqual(["1:import"])
    expect(problems("Text\n\nexport const meta = 1")).toEqual(["3:export"])
    expect(problems("Export your replay files and import them later.")).toEqual([])
    expect(problems("```\nimport x from 'y'\n```")).toEqual([])
  })

  it("says where and how to fix it, for the model", () => {
    const error = mdxError("Line one\n\nCome to <b>GM 2</b>, {free food}")
    expect(error).toMatch(/^The post's text must be plain Markdown/)
    expect(error).toContain('Here line 3 has "<" and "{" and "}" (Come to <b>GM 2</b>, {free food}).')
    expect(error).toMatch(/put any of these characters inside `code`/)
    expect(mdxError("<a>\n\n<b>\n\n<c>\n\n<d>\n\nimport x from 'y'")).toMatch(/line 1 has "<" \(<a>\); line 3 has "<" \(<b>\); line 5 has "<" \(<c>\) and 2 more lines\./)
  })
})

describe("markdownPreview", () => {
  it("keeps the structure the site renders", () => {
    const preview = markdownPreview(
      "# Title\n\nSome **bold**, *em*, ~~gone~~ and `code`  \nnext line.\n\n1. one\n2. two\n\n- [x] done\n- [ ] todo\n\n> quoted\n\n```js\nlet x = 1\n```\n\n| A | B |\n|:--|--:|\n| 1 | 2 |\n\n---\n\n[Rules](/lone-star-cup/rules) and [site][s] and ![a car](https://res.cloudinary.com/x/image/upload/car.jpg)\n\n[s]: https://example.com",
      { label: "How the post reads", title: "Post", excerpt: "Short" },
    )
    expect(preview).toMatchObject({ label: "How the post reads", title: "Post", excerpt: "Short" })
    expect(preview.truncated).toBeUndefined()
    expect(preview.blocks).toEqual([
      { t: "h", depth: 1, c: [{ t: "text", v: "Title" }] },
      {
        t: "p",
        c: [
          { t: "text", v: "Some " },
          { t: "strong", c: [{ t: "text", v: "bold" }] },
          { t: "text", v: ", " },
          { t: "em", c: [{ t: "text", v: "em" }] },
          { t: "text", v: ", " },
          { t: "del", c: [{ t: "text", v: "gone" }] },
          { t: "text", v: " and " },
          { t: "code", v: "code" },
          { t: "br" },
          { t: "text", v: "next line." },
        ],
      },
      { t: "list", ordered: true, items: [{ c: [{ t: "p", c: [{ t: "text", v: "one" }] }] }, { c: [{ t: "p", c: [{ t: "text", v: "two" }] }] }] },
      { t: "list", ordered: false, items: [{ checked: true, c: [{ t: "p", c: [{ t: "text", v: "done" }] }] }, { checked: false, c: [{ t: "p", c: [{ t: "text", v: "todo" }] }] }] },
      { t: "quote", c: [{ t: "p", c: [{ t: "text", v: "quoted" }] }] },
      { t: "code", lang: "js", v: "let x = 1" },
      { t: "table", align: ["left", "right"], rows: [[[{ t: "text", v: "A" }], [{ t: "text", v: "B" }]], [[{ t: "text", v: "1" }], [{ t: "text", v: "2" }]]] },
      { t: "hr" },
      {
        t: "p",
        c: [
          { t: "link", url: "/lone-star-cup/rules", c: [{ t: "text", v: "Rules" }] },
          { t: "text", v: " and " },
          { t: "link", url: "https://example.com", c: [{ t: "text", v: "site" }] },
          { t: "text", v: " and " },
          { t: "image", url: "https://res.cloudinary.com/x/image/upload/car.jpg", alt: "a car" },
        ],
      },
    ])
  })

  it("starts an ordered list where it starts, and stops at its size limit", () => {
    expect(markdownPreview("3. three\n4. four", { label: "x" }).blocks[0]).toMatchObject({ t: "list", ordered: true, start: 3 })
    const long = markdownPreview("word\n\n".repeat(25_000), { label: "x" })
    expect(long.truncated).toBe(true)
    expect(long.blocks.length).toBeLessThanOrEqual(20_000)
  })
})
