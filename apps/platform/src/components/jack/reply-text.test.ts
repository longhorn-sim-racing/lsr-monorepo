import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ReplyText } from "./reply-text"

const render = (text: string) => renderToStaticMarkup(createElement(ReplyText, { text, streaming: false }))

describe("links in a reply", () => {
  it("shows where a web link really goes, and flags one that sends data", () => {
    const html = render("Open [the Sponsors page](https://evil.example/?d=a@b.c) now.")
    expect(html).toContain('href="https://evil.example/?d=a@b.c"')
    expect(html).toContain('title="https://evil.example/?d=a@b.c"')
    expect(html).toContain('target="_blank"')
    expect(html).toMatch(/the Sponsors page<\/a><span[^>]*>.*evil\.example<\/span>/)
    expect(html).toContain("sends data")
  })

  it("shows the host a link's text pretends not to have", () => {
    expect(render("[https://www.longhornsimracing.org](https://evil.example/x)")).toMatch(/<\/a><span[^>]*>.*evil\.example<\/span>/)
    expect(render("https://stripe.com@evil.example/login")).toMatch(/<\/a><span[^>]*>.*evil\.example<\/span>/)
  })

  it("adds nothing to a plain link whose text is the URL, or to a site page", () => {
    const bare = render("See https://www.fia.com/esports.")
    expect(bare).toContain('<a href="https://www.fia.com/esports" title="https://www.fia.com/esports" target="_blank" rel="noreferrer"')
    expect(bare).not.toContain("opens ")
    expect(bare).not.toContain("sends data")
    const site = render("[Events](/admin/events) and /admin/jack/decks/abc")
    expect(site).toContain('href="/admin/events"')
    expect(site).toContain('href="/admin/jack/decks/abc"')
    expect(site).not.toContain("opens ")
    expect(site).not.toContain('target="_blank"')
  })

  it("draws a site link that would leave the site as plain text", () => {
    const html = render("[Events](/a/..//evil.example/x)")
    expect(html).not.toContain("<a")
    expect(html).toContain("Events")
  })

  it("keeps email links as they were", () => {
    expect(render("[Email Dylan](mailto:dylan@example.com)")).toContain('<a href="mailto:dylan@example.com" target="_blank" rel="noreferrer"')
  })
})
