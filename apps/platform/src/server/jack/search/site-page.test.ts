import { describe, expect, it, vi } from "vitest"
import { decodeEntities, htmlTitle, htmlToText, resolveStreamedHtml } from "./html-text"
import { PAGE_MAX_BYTES, readSitePage, sitePagePath } from "./site-page"

describe("sitePagePath: only the site's public pages", () => {
  it.each(["/", "/about", "/lone-star-cup", "/lone-star-cup/rules", "/events/gm-2", "/news/hello-world", "/gallery?album=fall-social", "/drivers/gray-marshall"])("allows %s", (path) => {
    expect(sitePagePath(path)).toEqual({ ok: true, path })
  })

  it("normalizes dot segments before checking", () => {
    expect(sitePagePath("/events/./gm-2")).toEqual({ ok: true, path: "/events/gm-2" })
  })

  it.each([
    "/admin",
    "/admin/jack",
    "/Admin/users",
    "/api/admin/jack/files/1",
    "/account",
    "/auth/callback",
    "/_next/static/chunk.js",
    "/events/../admin",
    "/events/%2e%2e/admin",
    "/%61dmin",
  ])("refuses %s (console, API, accounts, sign-in)", (path) => {
    expect(sitePagePath(path).ok).toBe(false)
  })

  it.each([
    "https://evil.example/",
    "//evil.example/page",
    "/\\evil.example",
    "\\\\evil.example",
    "/events\t/x",
    "/events\n/x",
    "/events /x",
    "/a%2f..%2fadmin",
    "/a%5cadmin",
    "about",
    "",
    "javascript:alert(1)",
    `/${"a".repeat(400)}`,
  ])("refuses %j (not a site path)", (path) => {
    expect(sitePagePath(path).ok).toBe(false)
  })

  it("explains a blocked page in words the model can act on", () => {
    expect(sitePagePath("/admin/users")).toEqual({ ok: false, error: expect.stringContaining("off-limits") })
    expect(sitePagePath("//evil.example")).toEqual({ ok: false, error: expect.stringContaining("isn't one of the site's public pages") })
  })
})

const html = (body: string, title = "Lone Star Cup | Longhorn Sim Racing") =>
  `<!doctype html><html><head><title>${title}</title><style>.x{}</style><script>self.__next_f.push([1,"secret payload"])</script></head><body><nav>Home Events</nav><main>${body}</main><footer>© LSR</footer></body></html>`

function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search
    const route = routes[path]
    return route ? route() : new Response("Not found", { status: 404, headers: { "content-type": "text/html" } })
  })
}

const ok = (body: string, type = "text/html; charset=utf-8") => () => new Response(body, { status: 200, headers: { "content-type": type } })
const redirect = (location: string) => () => new Response(null, { status: 307, headers: { location } })

describe("readSitePage", () => {
  const siteUrl = "https://www.longhornsimracing.org"

  it("fetches the page from the site with no cookies or credentials, and returns its main text", async () => {
    const fetcher = fakeFetch({ "/lone-star-cup": ok(html("<h1>Lone Star Cup</h1><p>Season 3 &amp; beyond.</p><ul><li>Round 1</li><li>Round 2</li></ul>")) })
    const page = await readSitePage("/lone-star-cup", { fetcher, siteUrl })
    expect(page).toEqual({ ok: true, path: "/lone-star-cup", title: "Lone Star Cup | Longhorn Sim Racing", text: "# Lone Star Cup\n\nSeason 3 & beyond.\n\n- Round 1\n- Round 2" })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://www.longhornsimracing.org/lone-star-cup")
    expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" })
    expect(new Headers(init.headers).get("cookie")).toBeNull()
    expect(new Headers(init.headers).get("authorization")).toBeNull()
  })

  it("never fetches a refused path", async () => {
    const fetcher = fakeFetch({})
    expect((await readSitePage("/admin", { fetcher, siteUrl })).ok).toBe(false)
    expect((await readSitePage("//evil.example", { fetcher, siteUrl })).ok).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("follows a redirect only to another public page on the site", async () => {
    const fetcher = fakeFetch({ "/lsc": redirect("/lone-star-cup"), "/lone-star-cup": ok(html("<p>Here</p>")) })
    expect(await readSitePage("/lsc", { fetcher, siteUrl })).toMatchObject({ ok: true, path: "/lone-star-cup", text: "Here" })

    const offSite = fakeFetch({ "/out": redirect("https://evil.example/steal") })
    expect(await readSitePage("/out", { fetcher: offSite, siteUrl })).toEqual({ ok: false, error: expect.stringContaining("off the site") })
    expect(offSite).toHaveBeenCalledTimes(1)

    const toSignIn = fakeFetch({ "/drivers/me/edit": redirect("/auth/sign-in?next=/drivers/me/edit") })
    expect(await readSitePage("/drivers/me/edit", { fetcher: toSignIn, siteUrl })).toEqual({ ok: false, error: expect.stringContaining("isn't a public page") })
    expect(toSignIn).toHaveBeenCalledTimes(1)

    const loop = fakeFetch({ "/a": redirect("/b"), "/b": redirect("/a") })
    expect(await readSitePage("/a", { fetcher: loop, siteUrl })).toEqual({ ok: false, error: expect.stringContaining("too many times") })
  })

  it("says so for a missing page, a non-page and an oversized one", async () => {
    expect(await readSitePage("/nope", { fetcher: fakeFetch({}), siteUrl })).toEqual({ ok: false, error: "There's no page at /nope." })
    expect(await readSitePage("/logo", { fetcher: fakeFetch({ "/logo": ok("PNG", "image/png") }), siteUrl })).toEqual({ ok: false, error: expect.stringContaining("isn't a page (image/png)") })
    const huge = "x".repeat(PAGE_MAX_BYTES + 10)
    expect(await readSitePage("/big", { fetcher: fakeFetch({ "/big": ok(huge) }), siteUrl })).toEqual({ ok: false, error: "/big is too large to read." })
  })

  it("reports a network failure without throwing", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED")
    })
    expect(await readSitePage("/about", { fetcher, siteUrl })).toEqual({ ok: false, error: "Couldn't load /about: connect ECONNREFUSED." })
  })
})

describe("htmlToText", () => {
  it("reads only <main>, drops scripts, styles and SVG, and keeps headings, lists and line breaks", () => {
    const text = htmlToText(
      html(`<section><h2 class="x">Who <em>we</em> are</h2><p>Line one<br>line two</p><svg><text>icon</text></svg><script>alert(1)</script><table><tr><th>Round</th><th>Track</th></tr><tr><td>1</td><td>Monza</td></tr></table></section><!-- a comment -->`),
    )
    expect(text).toBe("## Who we are\n\nLine one\nline two\n\nRound | Track |\n\n1 | Monza |")
    expect(text).not.toMatch(/secret payload|Home Events|© LSR|alert|icon|comment/)
  })

  it("reads the whole body when there's no <main>", () => {
    expect(htmlToText("<body><p>Plain</p></body>")).toBe("Plain")
  })

  it("reads a streamed page as it looks once loaded, not its loading placeholder", () => {
    // The shape Next.js and React stream: a Suspense fallback in <main>, the content in hidden
    // segments after it, and scripts that move them into place ($RC for a boundary, $RS for a placeholder)
    const streamed = [
      "<html><body><header>Site nav</header><main>",
      '<!--$?--><template id="B:0"></template><div role="status"><span>Loading</span><!--$--><div>nested fallback</div><!--/$--></div><!--/$-->',
      "</main><footer>Footer</footer>",
      '<div hidden id="S:0"><h1>About us</h1><div><p>Intro</p><template id="P:1"></template></div></div>',
      '<script>$RC("B:0","S:0")</script>',
      '<div hidden id="S:1"><h2>The board</h2><ul><li>Dylan</li></ul></div>',
      '<script>$RS("S:1","P:1")</script></body></html>',
    ].join("")
    expect(resolveStreamedHtml(streamed)).not.toMatch(/Loading|hidden id/)
    expect(htmlToText(streamed)).toBe("# About us\n\nIntro\n\n## The board\n\n- Dylan")
  })

  it("leaves a page that doesn't stream as it is", () => {
    const plain = "<main><p>Done</p></main>"
    expect(resolveStreamedHtml(plain)).toBe(plain)
  })
})

describe("decodeEntities and htmlTitle", () => {
  it("decodes named and numeric entities, and leaves unknown or invalid ones", () => {
    expect(decodeEntities("Tom &amp; Jerry &lt;3 &#39;hi&#39; &#x1F3C1; &nbsp;&bogus; &#0; &#xD800;")).toBe("Tom & Jerry <3 'hi' 🏁  &bogus; &#0; &#xD800;")
  })

  it("reads the page title on one line", () => {
    expect(htmlTitle("<title>\n  Events &amp; more\n</title>")).toBe("Events & more")
    expect(htmlTitle("<p>none</p>")).toBeNull()
  })
})
