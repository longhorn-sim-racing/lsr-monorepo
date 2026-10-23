import { describe, expect, it } from "vitest"
import { cleanCss, cleanSlideHtml, RENDER_VERSION, renderKey, roomAssetUrl, slideDocument, usesRoomAssets } from "./document"

describe("cleanSlideHtml", () => {
  it("drops scripts, meta refreshes, base URLs, stylesheets, frames and plugins", () => {
    const html = [
      '<section class="slide dark">',
      "<script>alert(1)</script>",
      '<SCRIPT src="https://evil.example/x.js"></SCRIPT>',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<base href="https://evil.example/">',
      '<link rel="stylesheet" href="https://evil.example/x.css">',
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x"></object><embed src="y">',
      "<h1 class=\"title\">Keep me</h1>",
      "</section>",
    ].join("")
    const clean = cleanSlideHtml(html)
    expect(clean).toBe('<section class="slide dark"><h1 class="title">Keep me</h1></section>')
  })

  it("leaves ordinary markup, inline styles, style elements and svg alone", () => {
    const html = '<section class="slide light"><style>.x{color:red}</style><svg width="10" height="10"><circle r="5"/></svg><p style="color:#FF8000">A linked idea</p></section>'
    expect(cleanSlideHtml(html)).toBe(html)
  })
})

describe("cleanCss", () => {
  it("can't close its own style element", () => {
    expect(cleanCss(".a{color:red}</style><script>x</script>")).toBe(".a{color:red}<\\/style><script>x</script>")
    expect(cleanCss(".a{} </ STYLE>")).toBe(".a{} <\\/style>")
  })
})

describe("slideDocument", () => {
  it("puts the content security policy first, then the base URL, fonts, kit and deck CSS, then the slide", () => {
    const doc = slideDocument({ size: "post", css: ".mine{color:red}", html: '<section class="slide dark">Hi</section>' })
    expect(doc).toContain('<html lang="en" data-size="post">')
    const order = ["Content-Security-Policy", "<base href=", "<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com", ".slide{", ".mine{color:red}", '<section class="slide dark">Hi</section>'].map((s) => doc.indexOf(s))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain("img-src data: https://res.cloudinary.com/daklxjoxr/image/upload/ https://www.longhornsimracing.org/images/ ")
    expect(doc).not.toMatch(/img-src[^;]*https:\/\/res\.cloudinary\.com /)
  })
})

describe("renderKey", () => {
  const base = { size: "slides" as const, css: "", html: "<section></section>" }

  it("is the same for the same slide and differs when anything that changes the picture does", () => {
    expect(renderKey(base)).toBe(renderKey({ ...base }))
    expect(renderKey({ ...base, size: "square" })).not.toBe(renderKey(base))
    expect(renderKey({ ...base, css: ".a{}" })).not.toBe(renderKey(base))
    expect(renderKey({ ...base, html: "<section> </section>" })).not.toBe(renderKey(base))
  })

  it("is a short hex name", () => {
    expect(renderKey(base)).toMatch(/^[0-9a-f]{40}$/)
    expect(RENDER_VERSION).toBeGreaterThan(0)
  })

  it("depends on the deck's room only for slides with room photos, so another room's deck never reuses one", () => {
    expect(renderKey({ ...base, roomId: "room-1" })).toBe(renderKey(base))
    const photo = { ...base, html: `<section><img src="${roomAssetUrl("11111111-2222-4333-8444-555555555555")}"></section>` }
    expect(renderKey({ ...photo, roomId: "room-1" })).not.toBe(renderKey({ ...photo, roomId: "room-2" }))
    expect(renderKey({ ...photo, roomId: "room-1" })).toBe(renderKey({ ...photo, roomId: "room-1" }))
    const background = { ...base, css: `.hero { background: url(https://jack.assets/room/x) }` }
    expect(usesRoomAssets(background)).toBe(true)
    expect(renderKey({ ...background, roomId: "room-1" })).not.toBe(renderKey(background))
  })
})
