import Anthropic from "@anthropic-ai/sdk"
import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { JackToolPart } from "@/lib/jack/parts"
import { fakeClaude, type FakeTurn } from "./fake-claude"
import { MAX_TOOL_RESULT_IMAGES, resultContent, runModelReply, toolDefinitions, type ModelReplyOptions } from "./model-loop"
import { JACK_MODELS } from "./models"
import { buildSystemPrompt } from "./prompt"
import type { AnyJackTool, JackTool, JackToolContext } from "./tools/types"

const history: BetaMessageParam[] = [{ role: "user", content: "[Tue, Oct 13, 2026, 3:05 PM CT]\nGray: How many members are there?" }]

function countTool(run?: JackTool<{ table: string }>["run"]): JackTool<{ table: string }> {
  return {
    name: "count_rows",
    description: "Counts the rows in a table.",
    input: z.object({ table: z.string() }),
    run: vi.fn(
      run ??
        (async ({ table }) => ({
          forModel: JSON.stringify({ table, count: 42 }),
          label: `Counted ${table} (42)`,
          displays: [{ kind: "note" as const, text: "42 rows" }],
        }))
    ),
  }
}

let parts: JackToolPart[][]
let streamed: string[]

function setup(script: FakeTurn[] | ((params: never, call: number) => FakeTurn), tools: AnyJackTool[] = [countTool()], extra: Partial<ModelReplyOptions> = {}) {
  const fake = fakeClaude(script as never)
  const options: ModelReplyOptions = {
    client: fake.client,
    config: JACK_MODELS.jack,
    system: buildSystemPrompt("jack"),
    tools,
    history,
    ctx: { roomId: "room-1", actor: { userId: "officer-gray", displayName: "Gray" } },
    onText: (text) => streamed.push(text),
    onPart: async (part) => {
      parts.push([part])
    },
    requestType: "room",
    ...extra,
  }
  return { fake, options, run: () => runModelReply(options) }
}

const partEvents = () => parts.map(([part]) => part)
const toolResults = (message: BetaMessageParam) =>
  (message.content as { type: string }[]).filter((block): block is BetaToolResultBlockParam => block.type === "tool_result")

beforeEach(() => {
  parts = []
  streamed = []
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "info").mockImplementation(() => {})
})

describe("runModelReply", () => {
  it("streams the text as it comes and ends with the whole answer", async () => {
    const { run, fake } = setup([{ text: "There are 42 members, from count_rows." }])

    const result = await run()

    expect(result).toMatchObject({ status: "done", outcome: "answered", text: "There are 42 members, from count_rows.", toolCalls: 0 })
    expect(streamed.length).toBeGreaterThan(1)
    expect(streamed.join("")).toBe(result.text)
    expect(fake.calls).toHaveLength(1)
  })

  it("asks Claude the right way: cached prefix, adaptive thinking, effort, eager tool input, refusal fallback", async () => {
    const { run, fake } = setup([{ text: "Done." }])
    await run()
    const [params] = fake.calls

    expect(params).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 32_000,
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"],
      messages: history,
    })
    expect(params.tool_choice).toBeUndefined() // forced tool use is a 400 on these models
    expect(params.tools).toEqual([
      expect.objectContaining({
        name: "count_rows",
        eager_input_streaming: true,
        input_schema: expect.objectContaining({ type: "object", properties: { table: { type: "string" } } }),
      }),
    ])
    expect(JSON.stringify(params.tools)).not.toContain("$schema")
    const system = params.system as { text: string; cache_control?: unknown }[]
    expect(system.at(-1)?.cache_control).toEqual({ type: "ephemeral" })
    expect(system[0].text).toContain("You are Jack")
  })

  it("runs a tool and sends the result back, saving the part as it goes", async () => {
    const tool = countTool()
    const { run, fake } = setup(
      [
        { text: "Let me count.", tools: [{ id: "toolu_a", name: "count_rows", input: { table: "User" } }], usage: { input: 900, output: 50, cacheWrite: 3000 } },
        { text: "There are 42 members (count_rows on User).", usage: { input: 60, output: 30, cacheRead: 3900 } },
      ],
      [tool]
    )

    const result = await run()

    expect(result).toMatchObject({ status: "done", outcome: "answered", toolCalls: 1 })
    expect(result.text).toBe("Let me count.\n\nThere are 42 members (count_rows on User).")
    expect(tool.run).toHaveBeenCalledWith({ table: "User" }, expect.objectContaining({ roomId: "room-1", actor: { userId: "officer-gray", displayName: "Gray" } }))

    // running as soon as the call starts, running with its input, then done
    expect(partEvents().map((p) => [p.status, p.input])).toEqual([
      ["running", null],
      ["running", { table: "User" }],
      ["done", { table: "User" }],
    ])
    const done = result.parts[0]
    expect(done).toMatchObject({ id: "toolu_a", name: "count_rows", label: "Counted User (42)", displays: [{ kind: "note", text: "42 rows" }] })
    expect(done.at).toBe("Let me count.".length)
    expect(result.text.slice(0, done.at)).toBe("Let me count.")
    expect(typeof done.ms).toBe("number")

    // the second call is the first plus the assistant turn as it came and the tool result: append-only
    const [first, second] = fake.calls
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages)
    expect(second.system).toEqual(first.system)
    expect(second.tools).toEqual(first.tools)
    const [assistant, user] = second.messages.slice(first.messages.length)
    expect(assistant.role).toBe("assistant")
    expect((assistant.content as BetaContentBlock[]).map((b) => b.type)).toEqual(["thinking", "text", "tool_use"])
    expect(toolResults(user)).toEqual([{ type: "tool_result", tool_use_id: "toolu_a", content: JSON.stringify({ table: "User", count: 42 }) }])

    // both calls add up: 900 + 60 in, 3000 written, 3900 read, 80 out on Sonnet 5.5
    expect(result.usage.tokens).toEqual({ inputTokens: 960, cacheWriteTokens: 3000, cacheReadTokens: 3900, outputTokens: 80 })
    expect(result.usage.costUsd).toBeCloseTo((960 * 2 + 3000 * 2.5 + 3900 * 0.2 + 80 * 10) / 1e6, 6)
  })

  it("shows the model a tool's images after its text, each after its caption, and keeps them out of the part", async () => {
    const tool = countTool(async () => ({
      forModel: "Rendered 2 slides.",
      label: "Rendered 2 slides",
      images: [
        { caption: "Slide 1:", mediaType: "image/jpeg", data: "AAAA" },
        { caption: "Slide 2:", mediaType: "image/png", data: "BBBB" },
      ],
    }))
    const { run, fake } = setup(
      [{ tools: [{ id: "toolu_r", name: "count_rows", input: { table: "Deck" } }] }, { text: "Both slides look right." }],
      [tool]
    )

    const result = await run()

    expect(toolResults(fake.calls[1].messages.at(-1)!)[0].content).toEqual([
      { type: "text", text: "Rendered 2 slides." },
      { type: "text", text: "Slide 1:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      { type: "text", text: "Slide 2:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
    ])
    expect(JSON.stringify(result.parts)).not.toContain("AAAA")
  })

  it("turns input that doesn't match the tool's schema into an error result, without running it", async () => {
    const tool = countTool()
    const { run, fake } = setup(
      [
        { tools: [{ id: "toolu_bad", name: "count_rows", input: { tabel: "User" } }] },
        { text: "Sorry, let me fix that." },
      ],
      [tool]
    )

    const result = await run()

    expect(tool.run).not.toHaveBeenCalled()
    const [toolResult] = toolResults(fake.calls[1].messages.at(-1)!)
    expect(toolResult).toMatchObject({ tool_use_id: "toolu_bad", is_error: true })
    const body = JSON.parse(toolResult.content as string)
    expect(JSON.parse(body.INVALID_JSON)).toEqual({ tabel: "User" })
    expect(body.problems.join(" ")).toMatch(/table/)
    expect(result.parts[0]).toMatchObject({ status: "error", label: "count_rows: invalid input" })
    expect(result.outcome).toBe("answered")
  })

  it("tells the model when a tool fails, and keeps going", async () => {
    const tool = countTool(async () => {
      throw new Error("statement timeout")
    })
    const { run, fake } = setup([{ tools: [{ name: "count_rows", input: { table: "Event" } }] }, { text: "That query timed out." }], [tool])

    const result = await run()

    expect(toolResults(fake.calls[1].messages.at(-1)!)[0]).toMatchObject({ is_error: true, content: "The tool failed: statement timeout" })
    expect(result.parts[0]).toMatchObject({ status: "error", label: "count_rows failed" })
    expect(result.status).toBe("done")
  })

  it("shows a tool's own error result as an error part", async () => {
    const tool = countTool(async () => ({ forModel: "No table named Usr", label: "Query failed: no table Usr", isError: true }))
    const { run, fake } = setup([{ tools: [{ name: "count_rows", input: { table: "Usr" } }] }, { text: "Hmm." }], [tool])

    const result = await run()

    expect(toolResults(fake.calls[1].messages.at(-1)!)[0]).toMatchObject({ is_error: true, content: "No table named Usr" })
    expect(result.parts[0]).toMatchObject({ status: "error", label: "Query failed: no table Usr", error: "No table named Usr" })
    expect(typeof result.parts[0].ms).toBe("number")
  })

  it("answers an unknown tool with an error, and matches a name that's only off by case", async () => {
    const tool = countTool()
    const { run, fake } = setup(
      [
        { tools: [{ id: "t1", name: "drop_table", input: {} }, { id: "t2", name: "Count_Rows", input: { table: "User" } }] },
        { text: "42." },
      ],
      [tool]
    )

    await run()

    const results = toolResults(fake.calls[1].messages.at(-1)!)
    expect(results[0]).toMatchObject({ tool_use_id: "t1", is_error: true })
    expect(results[0].content).toContain("count_rows")
    expect(results[1]).toMatchObject({ tool_use_id: "t2", content: JSON.stringify({ table: "User", count: 42 }) })
    expect(tool.run).toHaveBeenCalledTimes(1)
  })

  it("stops at the tool-call cap: skips the extra calls, then asks for an answer with tools off", async () => {
    const tool = countTool()
    const call = (n: number) => ({ id: `t${n}`, name: "count_rows", input: { table: `T${n}` } })
    const { run, fake } = setup(
      [{ tools: [call(1), call(2)] }, { tools: [call(3), call(4)] }, { text: "Here's what I found so far." }],
      [tool],
      { limits: { maxToolCalls: 3 } }
    )

    const result = await run()

    expect(tool.run).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ toolCalls: 3, outcome: "answered", status: "done" })
    const skipped = result.parts.find((p) => p.id === "t4")
    expect(skipped).toMatchObject({ status: "error", label: "Skipped: tool limit reached" })

    const last = fake.calls[2]
    expect(last.tool_choice).toEqual({ type: "none" })
    const lastUser = last.messages.at(-1)!.content as { type: string; text?: string }[]
    expect(toolResults(last.messages.at(-1)!).map((r) => r.tool_use_id)).toEqual(["t3", "t4"])
    expect(lastUser.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("Don't call any more tools") })
    expect(fake.calls[1].tool_choice).toBeUndefined()
  })

  it("gives a reply the design limits once it calls a deck tool, and asks for a hand-off note at the end", async () => {
    const design: AnyJackTool = { ...countTool(), name: "deck_write", design: true }
    const call = (id: string, name: string) => ({ id, name, input: { table: "x" } })
    const { run, fake } = setup(
      [
        { tools: [call("t1", "count_rows"), call("t2", "deck_write")] },
        { tools: [call("t3", "deck_write"), call("t4", "deck_write")] },
        { text: "Slides 1-3 are done; 4 is left." },
      ],
      [countTool(), design],
      { limits: { maxToolCalls: 2, maxDesignToolCalls: 4 } }
    )

    const result = await run()

    expect(result.toolCalls).toBe(4)
    expect(result.parts.map((p) => p.status)).toEqual(["done", "done", "done", "done"])
    const last = fake.calls[2].messages.at(-1)!.content as { type: string; text?: string }[]
    expect(last.at(-1)?.text).toMatch(/^You've used this reply's 4 tool calls\. Don't call any more tools: in a few sentences, say what's done \(with the deck's link\)/)
  })

  it("ends with a note if the model keeps calling tools after it's told to stop", async () => {
    const tool = countTool()
    const { run } = setup([{ tools: [{ name: "count_rows", input: { table: "A" } }] }, { tools: [{ name: "count_rows", input: { table: "B" } }] }], [tool], {
      limits: { maxToolCalls: 1 },
    })

    const result = await run()

    expect(tool.run).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe("tool_limit")
    expect(result.text).toMatch(/used up its tool calls/)
    expect(result.parts.every((p) => p.status !== "running")).toBe(true)
  })

  it("replaces a declined partial with a plain note on a refusal", async () => {
    const { run } = setup([{ text: "Sure, here is how to", stop: "refusal", refusalCategory: "cyber" }])

    const result = await run()

    expect(result).toMatchObject({ status: "done", outcome: "refusal" })
    expect(result.text).not.toContain("Sure, here is how to")
    expect(result.text).toMatch(/^I can't help with that one/)
    expect(streamed.join("")).toContain("Sure, here is how to") // it did stream; the reset takes it back
  })

  it("tells the caller to take back a declined partial", async () => {
    const resets: string[] = []
    const { run } = setup([{ text: "Sure, here is how to", stop: "refusal", refusalCategory: "cyber" }], undefined, { onReset: (text) => void resets.push(text) })

    await run()

    expect(resets).toEqual([""])
  })

  it("never runs a tool call cut off at max_tokens", async () => {
    const tool = countTool()
    const { run } = setup([{ text: "Checking.", tools: [{ name: "count_rows", input: { table: "Us" } }], stop: "max_tokens" }], [tool])

    const result = await run()

    expect(tool.run).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: "done", outcome: "cut_off" })
    expect(result.parts[0]).toMatchObject({ status: "error", label: "Didn't run: the reply hit its length limit" })
    expect(result.text).toMatch(/ran out of room/)
  })

  it("keeps a text answer cut off at max_tokens, with a note", async () => {
    const { run } = setup([{ text: "The events this month are", stop: "max_tokens" }])

    const result = await run()

    expect(result.text).toBe("The events this month are\n\n(This answer hit the length limit and was cut off.)")
    expect(result.status).toBe("done")
  })

  it.each([
    [new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers()), /too many requests/],
    [new Anthropic.AuthenticationError(401, { type: "error" }, "invalid x-api-key", new Headers()), /API key was rejected/],
    [new Anthropic.InternalServerError(529, { type: "error" }, "overloaded", new Headers()), /server error 529/],
    [new Anthropic.APIConnectionError({ message: "socket hang up" }), /network error/],
    [new Anthropic.BadRequestError(400, { type: "error" }, "bad", new Headers()), /bug in Jack/],
  ])("ends as an error with a plain message when the API call fails (%s)", async (error, message) => {
    const { run } = setup([{ text: "Partial answer", error }])

    const result = await run()

    expect(result).toMatchObject({ status: "error", outcome: "api_error" })
    expect(result.text).toMatch(/^Partial answer\n\n/)
    expect(result.text).toMatch(message)
  })

  it("reports usage after each call, including one that failed partway, so it can be saved as it goes", async () => {
    const seen: number[] = []
    const { run } = setup(
      [
        { text: "Let me", tools: [{ name: "count_rows", input: { table: "x" } }], usage: { input: 500, output: 5 }, error: new Error("Unable to parse tool parameter JSON") },
        { tools: [{ name: "count_rows", input: { table: "User" } }], usage: { input: 600, output: 10 } },
        { text: "42.", usage: { input: 700, output: 20 } },
      ],
      [countTool()],
      { onUsage: async (usage) => void seen.push(usage.tokens.inputTokens) }
    )

    const result = await run()

    expect(seen).toEqual([500, 1_100, 1_800])
    expect(result.usage.calls).toBe(3)
  })

  it("takes back the text of a garbled call (telling the caller) before the re-issued call writes its own", async () => {
    const resets: string[] = []
    const { run } = setup(
      [
        { text: "Before. ", tools: [{ name: "count_rows", input: { table: "x" } }] },
        { text: "Let me", tools: [{ id: "garbled", name: "count_rows", input: { table: "y" } }], error: new Error("Unable to parse tool parameter JSON") },
        { text: "Let me count.", tools: [{ name: "count_rows", input: { table: "User" } }] },
        { text: "42." },
      ],
      [countTool()],
      { onReset: (text) => void resets.push(text) }
    )

    const result = await run()

    expect(resets).toEqual(["Before. "])
    expect(result.text).toBe("Before. \n\nLet me count.\n\n42.")
    expect(result.parts.find((p) => p.id === "garbled")).toMatchObject({ status: "error", at: "Before. ".length })
  })

  it("re-issues a call whose streamed tool input wasn't JSON, then carries on", async () => {
    const tool = countTool()
    const { run, fake } = setup(
      [
        { text: "Let me", tools: [{ name: "count_rows", input: { table: "x" } }], error: new Error("Unable to parse tool parameter JSON") },
        { text: "Let me count.", tools: [{ id: "toolu_ok", name: "count_rows", input: { table: "User" } }] },
        { text: "42." },
      ],
      [tool]
    )

    const result = await run()

    expect(fake.calls).toHaveLength(3)
    expect(fake.calls[1].messages).toEqual(fake.calls[0].messages) // same request again
    expect(tool.run).toHaveBeenCalledTimes(1)
    expect(result.text).toBe("Let me count.\n\n42.")
    expect(result.outcome).toBe("answered")
  })

  it("after a refusal fallback mid-answer, sends back only what came after the switch", async () => {
    const fallback = { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" }, trigger: { type: "refusal" } } as unknown as BetaContentBlock
    const declined = [
      { type: "thinking", thinking: "", signature: "declined" },
      { type: "tool_use", id: "toolu_declined", name: "count_rows", input: { table: "x" } },
      fallback,
    ] as unknown as BetaContentBlock[]
    const tool = countTool()
    const { run, fake } = setup(
      [
        {
          leading: declined,
          text: "Counting.",
          tools: [{ id: "toolu_after", name: "count_rows", input: { table: "User" } }],
          model: "claude-sonnet-5",
          iterations: [
            { type: "message", model: "claude-sonnet-5-5", input: 1000, output: 10 },
            { type: "fallback_message", model: "claude-sonnet-5", input: 1000, output: 40 },
          ],
        },
        { text: "42.", model: "claude-sonnet-5" },
      ],
      [tool]
    )

    const result = await run()

    expect(tool.run).toHaveBeenCalledTimes(1)
    const echoed = fake.calls[1].messages.at(-2)!.content as BetaContentBlock[]
    expect(echoed.map((b) => (b.type === "thinking" ? `thinking:${b.signature}` : b.type))).toEqual([
      expect.stringMatching(/^thinking:sig-/),
      "text",
      "tool_use",
    ])
    expect(toolResults(fake.calls[1].messages.at(-1)!).map((r) => r.tool_use_id)).toEqual(["toolu_after"])
    expect(result.parts.find((p) => p.id === "toolu_declined")).toMatchObject({ status: "error", label: "Didn't run" })
    // closed as soon as the switch was seen, before the tools after it ran
    const events = partEvents().map((p) => `${p.id}:${p.status}`)
    expect(events.indexOf("toolu_declined:error")).toBeLessThan(events.indexOf("toolu_after:done"))
    // each attempt is priced at the rate of the model that ran it
    expect(result.usage.models).toEqual(["claude-sonnet-5-5", "claude-sonnet-5"])
  })

  it("sends no tools (and no tool_choice) when there are none", async () => {
    const { run, fake } = setup([{ text: "I can't look that up yet." }], [])
    await run()
    expect(fake.calls[0].tools).toBeUndefined()
    expect(fake.calls[0].tool_choice).toBeUndefined()
  })

  it("passes the tool context, with an abort signal, to each tool", async () => {
    let seen: JackToolContext | null = null
    const tool = countTool(async (_input, ctx) => {
      seen = ctx
      return { forModel: "ok", label: "ok" }
    })
    const { run } = setup([{ tools: [{ name: "count_rows", input: { table: "x" } }] }, { text: "ok" }], [tool])
    await run()
    expect(seen).toMatchObject({ roomId: "room-1", actor: { displayName: "Gray" } })
    expect(seen!.signal).toBeInstanceOf(AbortSignal)
  })
})

describe("cancelling a reply", () => {
  it("aborts a running tool through ctx.signal and the Claude call, and ends with a message", async () => {
    const cancel = new AbortController()
    let toolSignal: AbortSignal | undefined
    const tool = countTool(
      (_input, ctx) =>
        new Promise((_resolve, reject) => {
          toolSignal = ctx.signal
          ctx.signal?.addEventListener("abort", () => reject(new Error("query canceled")))
          cancel.abort()
        })
    )
    const { run, fake } = setup([{ tools: [{ name: "count_rows", input: { table: "x" } }] }, { text: "unused", error: new Anthropic.APIUserAbortError() }], [tool], {
      signal: cancel.signal,
    })
    const streamed = vi.spyOn(fake.client, "stream")

    const result = await run()

    expect(toolSignal?.aborted).toBe(true)
    expect(result.parts[0]).toMatchObject({ status: "error", label: "count_rows failed" })
    expect(streamed.mock.calls[0][1]).toEqual({ signal: cancel.signal })
    expect(result).toMatchObject({ status: "error", outcome: "api_error" })
    expect(result.text).toMatch(/stopped before it finished/)
  })
})

describe("resultContent", () => {
  it("is plain text when there are no images", () => {
    expect(resultContent("42 rows")).toBe("42 rows")
  })

  it(`caps the images at ${MAX_TOOL_RESULT_IMAGES} and says how many were left out`, () => {
    const images = Array.from({ length: MAX_TOOL_RESULT_IMAGES + 2 }, (_, i) => ({ caption: `Slide ${i + 1}:`, mediaType: "image/jpeg" as const, data: "x" }))
    const content = resultContent("Rendered.", images) as { type: string; text?: string }[]
    expect(content.filter((block) => block.type === "image")).toHaveLength(MAX_TOOL_RESULT_IMAGES)
    expect(content.at(-1)).toEqual({ type: "text", text: "(2 more images left out; ask for fewer at a time.)" })
  })
})

describe("toolDefinitions", () => {
  it("is stable for the same tool list (the tools are the start of the cached prefix)", () => {
    const tools = [countTool()]
    expect(toolDefinitions(tools)).toBe(toolDefinitions(tools))
    expect(JSON.stringify(toolDefinitions(tools))).toBe(JSON.stringify(toolDefinitions([countTool()])))
  })
})
