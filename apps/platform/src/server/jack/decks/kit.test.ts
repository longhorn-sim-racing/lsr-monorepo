import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { JACK_DECK_SIZE_KEYS } from "@/lib/jack/decks"
import { SITE_ASSETS } from "./assets"
import { DESIGN_GUIDE } from "./design-guide"
import { KIT_CSS } from "./kit-css"
import { SLIDE_TEMPLATES } from "./templates"

/** Classes the templates use that aren't the kit's (none so far) */
const NOT_KIT = new Set<string>()

describe("the slide kit", () => {
  it("defines every class the templates use", () => {
    const used = new Set(SLIDE_TEMPLATES.flatMap((t) => [...t.html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))))
    const missing = [...used].filter((name) => !NOT_KIT.has(name) && !new RegExp(`\\.${name}(?![\\w-])`).test(KIT_CSS))
    expect(missing).toEqual([])
  })

  it("sets the canvas and type sizes for every deck size", () => {
    for (const size of JACK_DECK_SIZE_KEYS) expect(KIT_CSS).toMatch(new RegExp(`:root\\[data-size=${size}\\]\\{--w:\\d+px;--h:\\d+px;`))
  })

  it("has a template for every size", () => {
    expect(new Set(SLIDE_TEMPLATES.map((t) => t.size))).toEqual(new Set(JACK_DECK_SIZE_KEYS))
  })

  it("puts every template in the design guide", () => {
    for (const template of SLIDE_TEMPLATES) expect(DESIGN_GUIDE).toContain(template.html)
  })

  it("only points templates at the site's own images and QR codes", () => {
    for (const template of SLIDE_TEMPLATES) {
      for (const [, src] of template.html.matchAll(/src="([^"]+)"/g)) expect(src, template.name).toMatch(/^(\/(images|brand|sponsors|partners)\/|https:\/\/jack\.assets\/qr\?text=)/)
    }
  })
})

describe("SITE_ASSETS", () => {
  it("lists files that exist in public/", () => {
    const publicDir = path.resolve(__dirname, "../../../../public")
    const missing = SITE_ASSETS.filter((asset) => !existsSync(path.join(publicDir, asset.url)))
    expect(missing.map((a) => a.url)).toEqual([])
  })

  it("covers every photo the templates use", () => {
    const listed = new Set(SITE_ASSETS.map((a) => a.url))
    for (const template of SLIDE_TEMPLATES) {
      for (const [, src] of template.html.matchAll(/src="(\/[^"]+)"/g)) expect(listed.has(src), `${template.name}: ${src}`).toBe(true)
    }
  })
})
