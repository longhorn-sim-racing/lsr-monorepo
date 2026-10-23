import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeCitedText, fakeWebFetch, fakeWebSearch } from "./fake-claude"
import { addCitations, addLinkedPages, pendingServerCalls, recordWebResult, webErrorText, webPartFields, webServerTools, webToolsOn, type WebCall } from "./web-tools"

const call = (fields: Partial<WebCall> & Pick<WebCall, "id" | "name">): WebCall => ({ input: null, found: null, error: null, startedAt: 1_000, ...fields })

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("webToolsOn", () => {
  it("is on only for JACK_WEB_TOOLS=on", () => {
    expect(webToolsOn()).toBe(false)
    vi.stubEnv("JACK_WEB_TOOLS", " ON ")
    expect(webToolsOn()).toBe(true)
    vi.stubEnv("JACK_WEB_TOOLS", "true")
    expect(webToolsOn()).toBe(false)
  })
})

describe("webServerTools", () => {
  it("never lets web_fetch follow a client tool's results, except web_links' when it's there", () => {
    const [, without] = webServerTools(["run_sql", "club_members"])
    expect(without.url_sources).toEqual({ user_input: { type: "all" }, server_tool_results: { type: "all" }, client_tool_results: { type: "none" } })
    const [, withLinks] = webServerTools(["run_sql", "web_links"])
    expect(withLinks.url_sources?.client_tool_results).toEqual({ type: "only", tools: [{ type: "tool_reference", name: "web_links" }] })
  })
})

describe("recordWebResult", () => {
  it("reads search results, fetched pages and error objects, and times the call", () => {
    const [, searchResult] = fakeWebSearch("q", [{ url: "https://a.example/1", title: "A" }, { url: "https://b.example/2" }])
    const search = call({ id: "s", name: "web_search" })
    recordWebResult(search, searchResult, 1_250)
    expect(search).toMatchObject({ found: [{ url: "https://a.example/1", title: "A" }, { url: "https://b.example/2", title: "https://b.example/2" }], error: null, ms: 250 })

    const [, failed] = fakeWebSearch("q", { error: "max_uses_exceeded" })
    const busy = call({ id: "s2", name: "web_search" })
    recordWebResult(busy, failed, 1_000)
    expect(busy).toMatchObject({ found: [], error: "max_uses_exceeded" })

    const [, page] = fakeWebFetch("https://c.example/page", { title: "C" })
    const fetch = call({ id: "f", name: "web_fetch" })
    recordWebResult(fetch, page, 1_000)
    expect(fetch.found).toEqual([{ url: "https://c.example/page", title: "C" }])
  })

  it("treats a result shaped in a way it doesn't expect as a failure, without throwing", () => {
    const odd = call({ id: "f", name: "web_fetch" })
    recordWebResult(odd, { type: "web_fetch_tool_result", tool_use_id: "f", content: null } as unknown as BetaContentBlock, 1_000)
    expect(odd).toMatchObject({ found: [], error: "unknown" })
  })
})

describe("addLinkedPages", () => {
  const acc = { url: "https://www.assettocorsa.net/forum/index.php?threads/acc-v1-10-4.123/", title: "ACC v1.10.4 OUT NOW" }
  const news = { url: "https://traxion.gg/acc-update/", title: "ACC update" }
  const searches = [call({ id: "s1", name: "web_search", input: { query: "acc latest version" }, found: [acc, news] })]

  it("counts the search results the text links to as cited, with the result's title (dynamic filtering sends no citations)", () => {
    const cited = new Map<string, string | null>()
    addLinkedPages(cited, "It's **v1.10.4**, from the [official forum](https://www.AssettoCorsa.net/forum/index.php?threads/acc-v1-10-4.123#post-9).", searches)
    expect([...cited]).toEqual([[acc.url, acc.title]])
    expect(webPartFields(searches, cited).get("s1")).toMatchObject({
      label: "Searched the web (2 results, 1 cited)",
      displays: [{ sources: [{ title: "ACC v1.10.4 OUT NOW", url: acc.url, host: "assettocorsa.net" }] }],
    })
  })

  it("matches a bare link without its trailing slash or sentence punctuation", () => {
    const cited = new Map<string, string | null>()
    addLinkedPages(cited, "See https://traxion.gg/acc-update.", searches)
    expect([...cited.keys()]).toEqual([news.url])
  })

  it("leaves out links that no search found, and pages already cited keep their citation's title", () => {
    const cited = new Map<string, string | null>([[news.url, "As cited"]])
    addLinkedPages(cited, "From https://elsewhere.example/acc and https://traxion.gg/acc-update/", searches)
    expect([...cited]).toEqual([[news.url, "As cited"]])
  })

  it("matches a link with parentheses, http for https, no www, or written out as typed", () => {
    const wiki = { url: "https://en.wikipedia.org/wiki/Assetto_Corsa_(video_game)", title: "Assetto Corsa" }
    const plain = { url: "https://en.wikipedia.org/wiki/Assetto_Corsa", title: "Not this one" }
    const accents = { url: "https://www.example.com/caf%C3%A9-racing", title: "Café racing" }
    const found = [call({ id: "s1", name: "web_search", found: [wiki, plain, accents, acc] })]
    const cited = new Map<string, string | null>()
    addLinkedPages(cited, "See [Wikipedia](https://en.wikipedia.org/wiki/Assetto_Corsa_(video_game)), http://example.com/café-racing and http://assettocorsa.net/forum/index.php?threads/acc-v1-10-4.123", found)
    expect([...cited.keys()].sort()).toEqual([acc.url, accents.url, wiki.url].sort())
  })

  it("doesn't count a longer link, another host ending the same way, or a link with no scheme", () => {
    const cited = new Map<string, string | null>()
    addLinkedPages(cited, "https://traxion.gg/acc-update.html, https://traxion.gg/acc-update/more, https://traxion.gg/acc-update?page=2, https://not-traxion.gg/acc-update/ and traxion.gg/acc-update", searches)
    expect(cited.size).toBe(0)
  })

  it("stays quick on a long run of punctuation, and does nothing without a search", () => {
    const text = `https://traxion.gg/${".".repeat(100_000)}x`
    const started = performance.now()
    addLinkedPages(new Map(), text, searches)
    addLinkedPages(new Map(), text, [])
    expect(performance.now() - started).toBeLessThan(200)
  })

  it("only looks at searches: a fetched page shows as read already", () => {
    const cited = new Map<string, string | null>()
    addLinkedPages(cited, "From https://traxion.gg/acc-update/", [call({ id: "f1", name: "web_fetch", input: { url: news.url }, found: [news] })])
    expect(cited.size).toBe(0)
  })
})

describe("webPartFields", () => {
  it("lists only cited results, each page under the first search that found it, in search order", () => {
    const a = { url: "https://a.example/", title: "A" }
    const b = { url: "https://b.example/", title: "B" }
    const c = { url: "https://c.example/", title: null }
    const cited = new Map<string, string | null>()
    addCitations(cited, [fakeCitedText("x", [{ url: b.url }, { url: c.url, title: "C as cited" }]), fakeCitedText("y", [{ url: a.url }])])
    const calls = [
      call({ id: "s1", name: "web_search", input: { query: "first" }, found: [b, c], ms: 900 }),
      call({ id: "s2", name: "web_search", input: { query: "second" }, found: [a, b] }),
      call({ id: "s3", name: "web_search", input: { query: "third" } }),
    ]

    const fields = webPartFields(calls, cited)

    expect(fields.get("s1")).toEqual({
      name: "web_search",
      input: { query: "first" },
      ms: 900,
      label: "Searched the web (2 results, 2 cited)",
      status: "done",
      displays: [
        {
          kind: "web_sources",
          queries: ["first"],
          sources: [
            { title: "B", url: b.url, host: "b.example" },
            { title: "C as cited", url: c.url, host: "c.example" },
          ],
        },
      ],
    })
    expect(fields.get("s2")).toMatchObject({ label: "Searched the web (2 results, 1 cited)", displays: [{ sources: [{ url: a.url }] }] })
    expect(fields.get("s3")).toMatchObject({ label: "Searching the web", status: "running", displays: [{ queries: ["third"], sources: [] }] })
  })

  it("shows a search whose input hasn't arrived without a display, and a fetch by the page's host", () => {
    const fields = webPartFields(
      [
        call({ id: "s", name: "web_search" }),
        call({ id: "f1", name: "web_fetch", input: { url: "https://www.fia.com/x" } }),
        call({ id: "f2", name: "web_fetch", input: { url: "https://www.fia.com/x" }, found: [{ url: "https://www.fia.com/x", title: null }] }),
        call({ id: "f3", name: "web_fetch", input: { url: "not a url" }, found: [], error: "url_not_in_prior_context" }),
      ],
      new Map()
    )
    expect(fields.get("s")).toMatchObject({ label: "Searching the web", displays: [] })
    expect(fields.get("f1")).toMatchObject({ label: "Opening fia.com", status: "running" })
    expect(fields.get("f2")).toMatchObject({ label: "Read fia.com", status: "done", displays: [{ kind: "web_sources", queries: [], sources: [{ title: "https://www.fia.com/x", host: "fia.com" }] }] })
    expect(fields.get("f3")).toMatchObject({
      label: "Couldn't open a web page",
      status: "error",
      error: "Couldn't open the page: only links an officer posted or a web search found can be opened",
    })
  })

  it("names an error code it doesn't know", () => {
    expect(webErrorText("something_new")).toBe("error something_new")
  })
})

describe("pendingServerCalls", () => {
  it("finds the server calls in a turn without their results", () => {
    const [searchCall, searchResult] = fakeWebSearch("q", [], { id: "srvtoolu_a" })
    const [fetchCall] = fakeWebFetch("https://a.example", {}, { id: "srvtoolu_b" })
    const toolUse = { type: "tool_use", id: "toolu_c", name: "run_sql", input: {} } as BetaContentBlock
    expect(pendingServerCalls([searchCall, searchResult, fetchCall, toolUse])).toEqual(["srvtoolu_b"])
    expect(pendingServerCalls([searchCall, searchResult])).toEqual([])
  })
})
