import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { JackProposalPreview } from "@/lib/jack/markdown-preview"
import { MarkdownPreview } from "./markdown-preview"

const render = (preview: JackProposalPreview) => renderToStaticMarkup(createElement(MarkdownPreview, { preview }))

describe("MarkdownPreview", () => {
  it("draws the post's structure, with its title and excerpt", () => {
    const html = render({
      label: "How the post reads",
      title: "Round 3",
      excerpt: "A recap",
      blocks: [
        { t: "h", depth: 2, c: [{ t: "text", v: "Results" }] },
        { t: "list", ordered: true, start: 3, items: [{ c: [{ t: "p", c: [{ t: "strong", c: [{ t: "text", v: "Ana" }] }] }] }] },
        { t: "list", ordered: false, items: [{ checked: true, c: [{ t: "p", c: [{ t: "text", v: "done" }] }] }] },
        { t: "table", align: ["left", null], rows: [[[{ t: "text", v: "A" }], [{ t: "text", v: "B" }]], [[{ t: "text", v: "1" }], [{ t: "text", v: "2" }]]] },
        { t: "code", lang: "js", v: "let x = 1" },
      ],
    })
    expect(html).toContain("<h1")
    expect(html).toContain(">Round 3</h1>")
    expect(html).toContain("A recap")
    expect(html).toContain("<h2>Results</h2>")
    expect(html).toContain('<ol start="3"><li><strong>Ana</strong></li></ol>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<th style="text-align:left">A</th>')
    expect(html).toContain("<pre><code>let x = 1</code></pre>")
  })

  it("never puts the text's markup on the page, and never loads a picture", () => {
    const html = render({
      label: "x",
      blocks: [
        {
          t: "p",
          c: [
            { t: "text", v: "<script>alert(1)</script>" },
            { t: "image", url: "https://tracker.example/pixel.gif?data=1", alt: "A car" },
            { t: "link", url: "https://www.twitch.tv/lsr", c: [{ t: "text", v: "Watch" }] },
            { t: "link", url: "javascript:alert(1)", c: [{ t: "text", v: "Bad" }] },
          ],
        },
      ],
    })
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toMatch(/<img/)
    expect(html).toContain("A car")
    expect(html).toContain("tracker.example")
    expect(html).toContain('href="https://www.twitch.tv/lsr"')
    expect(html).toContain("twitch.tv")
    expect(html).not.toContain("javascript:")
  })
})
