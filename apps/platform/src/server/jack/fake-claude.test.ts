import type { BetaContentBlockParam, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { describe, expect, it } from "vitest"
import { fakeCitedText, fakeClaude, fakeFileId, fakeToolSearch, fakeWebFetch, fakeWebSearch, requestProblem, searchDeferredTools } from "./fake-claude"

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
