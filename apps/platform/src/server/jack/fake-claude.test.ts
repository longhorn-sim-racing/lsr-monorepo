import type { BetaContentBlockParam, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { describe, expect, it } from "vitest"
import { enforceServerTools, fakeCitedText, fakeClaude, fakeFileId, fakeToolSearch, fakeWebFetch, fakeWebSearch, fetchableUrl, requestProblem, searchDeferredTools } from "./fake-claude"

/** The fake's stand-ins for the API's request checks, so the model loop's tests can trust a pass */

const page = { url: "https://a.example/", title: "A" }
const request = (fields: Partial<BetaMessageStreamParams>): BetaMessageStreamParams => ({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...fields })
const assistant = (content: unknown[]) => ({ role: "assistant" as const, content: content as BetaContentBlockParam[] })
const user = (content: unknown[]) => ({ role: "user" as const, content: content as BetaContentBlockParam[] })
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, input_schema: { type: "object" as const }, ...extra })

describe("requestProblem", () => {
  it("passes a well-formed web turn", () => {
    const [call, result] = fakeWebSearch("q", [page])
    expect(requestProblem(request({ messages: [{ role: "user", content: "hi" }, assistant([call, result, fakeCitedText("A says so.", [page])])] }))).toBeNull()
  })

  it("rejects every tool deferred, cache_control on a deferred tool, and a url_sources tool that isn't there", () => {
    expect(requestProblem(request({ tools: [tool("a", { defer_loading: true })] }))).toMatch(/defer_loading=false/)
    expect(requestProblem(request({ tools: [tool("a"), tool("b", { defer_loading: true, cache_control: { type: "ephemeral" } })] }))).toMatch(/cache_control/)
    const fetch = { type: "web_fetch_20260209", name: "web_fetch", url_sources: { client_tool_results: { type: "only", tools: [{ type: "tool_reference", name: "web_links" }] } } }
    expect(requestProblem(request({ tools: [tool("a"), fetch] as never }))).toMatch(/web_links/)
  })

  it("rejects forced tool use on Sonnet and Opus 5.5", () => {
    expect(requestProblem(request({ tools: [tool("a")], tool_choice: { type: "any" } }))).toMatch(/not supported/)
    expect(requestProblem(request({ model: "claude-haiku-5-5", tools: [tool("a")], tool_choice: { type: "any" } }))).toBeNull()
  })

  it("rejects a tool_result for a server call, and text with the tool results while a server call is running", () => {
    const [fetchCall] = fakeWebFetch("https://a.example/", {}, { id: "srvtoolu_x" })
    const toolUse = { type: "tool_use", id: "toolu_y", name: "a", input: {} }
    expect(requestProblem(request({ messages: [user([{ type: "text", text: "hi" }]), assistant([fetchCall, toolUse]), user([{ type: "tool_result", tool_use_id: "srvtoolu_x", content: "x" }])] }))).toMatch(/answers a server tool call/)
    expect(
      requestProblem(
        request({ messages: [user([{ type: "text", text: "hi" }]), assistant([fetchCall, toolUse]), user([{ type: "tool_result", tool_use_id: "toolu_y", content: "x" }, { type: "text", text: "wrap up" }])] })
      )
    ).toMatch(/only tool_result blocks/)
    expect(requestProblem(request({ messages: [user([{ type: "text", text: "hi" }]), assistant([fetchCall, toolUse]), user([{ type: "tool_result", tool_use_id: "toolu_y", content: "x" }])] }))).toBeNull()
  })

  it("rejects a server result with no call before it, a changed encrypted_content and an unknown tool reference", () => {
    const [, result] = fakeWebSearch("q", [page])
    expect(requestProblem(request({ messages: [user([{ type: "text", text: "hi" }]), assistant([result])] }))).toMatch(/no server_tool_use before it/)

    const [call, original] = fakeWebSearch("q", [page])
    const edited = structuredClone(original) as unknown as { content: { encrypted_content: string }[] }
    edited.content[0].encrypted_content = "tampered"
    expect(requestProblem(request({ messages: [user([{ type: "text", text: "hi" }]), assistant([call, edited])] }))).toMatch(/encrypted_content/)

    expect(requestProblem(request({ tools: [tool("a")], messages: [user([{ type: "text", text: "hi" }]), assistant(fakeToolSearch("q", ["stripe_overview"]))] }))).toMatch(
      /Tool reference 'stripe_overview' not found/
    )
  })

  it("rejects a Files API id in the wrong block type, and citations on some documents but not others", () => {
    const toolResult = (content: unknown[]) => user([{ type: "tool_result", tool_use_id: "toolu_1", content }])
    const turn = (result: ReturnType<typeof user>) => request({ messages: [user([{ type: "text", text: "hi" }]), assistant([{ type: "tool_use", id: "toolu_1", name: "a", input: {} }]), result] })
    const pdf = fakeFileId("pdf")
    const image = fakeFileId("image")
    expect(requestProblem(turn(toolResult([{ type: "document", source: { type: "file", file_id: pdf } }])))).toBeNull()
    expect(requestProblem(turn(toolResult([{ type: "document", source: { type: "file", file_id: image } }])))).toMatch(/is an image/)
    expect(requestProblem(turn(toolResult([{ type: "image", source: { type: "file", file_id: pdf } }])))).toMatch(/is a PDF/)
    expect(
      requestProblem(
        turn(
          toolResult([
            { type: "document", source: { type: "file", file_id: pdf }, citations: { enabled: true } },
            { type: "document", source: { type: "file", file_id: fakeFileId("pdf") } },
          ])
        )
      )
    ).toMatch(/all of the documents or none/)
    // A fetched page is a document too, without citations
    const [fetchCall, fetchResult] = fakeWebFetch("https://a.example/", {})
    expect(
      requestProblem(
        request({
          messages: [
            user([{ type: "text", text: "hi" }]),
            assistant([fetchCall, fetchResult, { type: "tool_use", id: "toolu_1", name: "a", input: {} }]),
            toolResult([{ type: "document", source: { type: "file", file_id: pdf }, citations: { enabled: true } }]),
          ],
        })
      )
    ).toMatch(/all of the documents or none/)
  })

  it("fails the stream with a 400 the way the SDK does", async () => {
    const fake = fakeClaude([{ text: "unused" }])
    const stream = fake.client.stream(request({ tools: [tool("a", { defer_loading: true })] }))
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 400 })
    expect(fake.calls).toHaveLength(1)
  })
})

describe("what web_fetch may open (fetchableUrl and enforceServerTools)", () => {
  const link = "https://b.example/page"
  const fetchTool = (url_sources?: Record<string, unknown>, max_uses?: number) => ({ type: "web_fetch_20260209", name: "web_fetch", ...(max_uses ? { max_uses } : {}), ...(url_sources ? { url_sources } : {}) })
  const sqlTurn = (text: string) => [
    assistant([{ type: "tool_use", id: "toolu_sql", name: "run_sql", input: {} }]),
    user([{ type: "tool_result", tool_use_id: "toolu_sql", content: text }]),
  ]
  const linksTurn = (text: string) => [
    assistant([{ type: "tool_use", id: "toolu_links", name: "web_links", input: {} }]),
    user([{ type: "tool_result", tool_use_id: "toolu_links", content: [{ type: "text", text }] }]),
  ]
  const jackOnly = { client_tool_results: { type: "only", tools: [{ type: "tool_reference", name: "web_links" }] } }

  it("follows officers' messages, and earlier search and fetch results", () => {
    expect(fetchableUrl(request({ messages: [{ role: "user", content: `Open ${link}` }] }), link)).toBe(true)
    expect(fetchableUrl(request({ messages: [user([{ type: "text", text: `Open ${link}` }])] }), link)).toBe(true)
    const [call, result] = fakeWebSearch("q", [{ url: link }])
    expect(fetchableUrl(request({ messages: [user([{ type: "text", text: "hi" }]), assistant([call, result])] }), link)).toBe(true)
    // Earlier in the same response
    expect(fetchableUrl(request({}), link, [call, result])).toBe(true)
  })

  it("never follows the model's own text, its tool inputs, or a tool search result", () => {
    const [searchCall] = fakeWebSearch(link, [])
    const messages = [
      user([{ type: "text", text: "hi" }]),
      assistant([{ type: "text", text: `See ${link}` }, searchCall, ...fakeToolSearch(link, [])]),
      user([{ type: "text", text: "and?" }]),
    ]
    expect(fetchableUrl(request({ messages }), link)).toBe(false)
  })

  it("follows client tool results only as url_sources says", () => {
    const sql = request({ messages: [user([{ type: "text", text: "hi" }]), ...sqlTurn(`{"url":"${link}"}`)] })
    const links = request({ messages: [user([{ type: "text", text: "hi" }]), ...linksTurn(`{"url":"${link}"}`)] })
    const withFetch = (params: BetaMessageStreamParams, url_sources?: Record<string, unknown>) => ({ ...params, tools: [fetchTool(url_sources)] as never })

    // The API's default: every client tool's results
    expect(fetchableUrl(withFetch(sql), link)).toBe(true)
    expect(fetchableUrl(withFetch(sql, { client_tool_results: { type: "none" } }), link)).toBe(false)
    expect(fetchableUrl(withFetch(sql, jackOnly), link)).toBe(false)
    expect(fetchableUrl(withFetch(links, jackOnly), link)).toBe(true)
    expect(fetchableUrl(withFetch(sql, { client_tool_results: { type: "except", tools: [{ type: "tool_reference", name: "run_sql" }] } }), link)).toBe(false)
    expect(fetchableUrl(withFetch(links, { client_tool_results: { type: "except", tools: [{ type: "tool_reference", name: "run_sql" }] } }), link)).toBe(true)
  })

  it("answers a fetch it may not open with url_not_in_prior_context, and a call past max_uses with max_uses_exceeded", () => {
    const params = request({ tools: [fetchTool(jackOnly, 2)] as never, messages: [user([{ type: "text", text: "Open https://a.example/ and https://c.example/" }]), ...sqlTurn(link)] })
    const blocks = [...fakeWebFetch("https://a.example/", {}), ...fakeWebFetch(link, {}), ...fakeWebFetch("https://c.example/", {})]

    const out = enforceServerTools(params, blocks) as unknown as { type: string; content?: { type?: string; error_code?: string } }[]

    expect(out.filter((block) => block.type === "web_fetch_tool_result").map((block) => block.content?.error_code ?? block.content?.type)).toEqual([
      "web_fetch_result",
      "url_not_in_prior_context",
      "max_uses_exceeded",
    ])
    expect(out[3].content).toEqual({ type: "web_fetch_tool_result_error", error_code: "url_not_in_prior_context" })
  })

  it("checks a result that finishes a call from the turn before (a mixed turn)", () => {
    const [call, result] = fakeWebFetch(link, {}, { id: "srvtoolu_mixed" })
    const turn = (text: string) =>
      request({ messages: [user([{ type: "text", text }]), assistant([call, { type: "tool_use", id: "toolu_a", name: "a", input: {} }]), user([{ type: "tool_result", tool_use_id: "toolu_a", content: "ok" }])] })
    const codeOf = (params: BetaMessageStreamParams) => (enforceServerTools(params, [result])[0] as unknown as { content: { type: string; error_code?: string } }).content
    expect(codeOf(turn(`Open ${link}`))).toMatchObject({ type: "web_fetch_result" })
    expect(codeOf(turn("Open the page"))).toEqual({ type: "web_fetch_tool_result_error", error_code: "url_not_in_prior_context" })
  })
})

describe("searchDeferredTools", () => {
  it("matches the request's deferred tools on their names and descriptions, best first", () => {
    const params = {
      tools: [
        tool("run_sql"),
        tool("stripe_overview", { defer_loading: true, description: "Stripe balance, payouts and refunds" }),
        tool("twitch_stats", { defer_loading: true, description: "Twitch streams and followers" }),
        tool("email_delivery", { defer_loading: true, description: "Delivery status and bounces for emails, refunds receipts" }),
      ],
    }
    expect(searchDeferredTools(params, "stripe refunds")).toEqual(["stripe_overview", "email_delivery"])
    expect(searchDeferredTools(params, "run sql")).toEqual([])
  })
})
