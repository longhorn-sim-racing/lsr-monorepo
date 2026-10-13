/**
 * Test helper: a scripted stand-in for the Anthropic SDK, shaped like JackModelClient. Each call takes
 * the next turn of the script (or asks a function for it) and streams it as the real API would:
 * message_start, a thinking block, text deltas, tool_use blocks with input_json_delta, message_delta,
 * message_stop; finalMessage() resolves with the assembled message. An aborted signal stops it the way
 * the SDK does (APIUserAbortError). No network. Not used by the app; scripts use it for dry runs.
 */
import Anthropic from "@anthropic-ai/sdk"
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import type { JackModelClient, JackModelStream } from "./model-loop"

export type FakeToolCall = { id?: string; name: string; input: unknown }

export type FakeTurn = {
  /** Text the model writes, before any tool calls */
  text?: string
  tools?: FakeToolCall[]
  /** Defaults to tool_use when there are tools, end_turn otherwise */
  stop?: BetaStopReason
  model?: string
  refusalCategory?: "cyber" | "bio" | "frontier_llm" | "reasoning_extraction" | "general_harms" | null
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  /** Usage per attempt, as a refusal fallback reports it */
  iterations?: { type: "message" | "fallback_message"; model: string; input: number; output: number; cacheRead?: number; cacheWrite?: number }[]
  /** Content blocks to put first (e.g. a fallback switch point) */
  leading?: BetaContentBlock[]
  /** Thrown from the stream after the text has streamed (an APIError, or a plain Error for unparseable tool JSON) */
  error?: Error
}

type Script = FakeTurn[] | ((params: BetaMessageStreamParams, call: number) => FakeTurn)

export type FakeClaudeOptions = {
  /** Text is streamed in pieces of about this many characters */
  chunkSize?: number
  /** Wait between pieces (setTimeout, so fake timers control it) */
  chunkDelayMs?: number
}

export function fakeClaude(script: Script, createScript: Script = () => ({ text: "Fake Room Name" }), options: FakeClaudeOptions = {}) {
  const calls: BetaMessageStreamParams[] = []
  const creates: MessageCreateParamsNonStreaming[] = []
  let toolIds = 0

  const turnFor = (s: Script, params: BetaMessageStreamParams, index: number): FakeTurn => {
    const turn = typeof s === "function" ? s(params, index) : s[index]
    if (!turn) throw new Error(`The fake Claude script has no turn ${index + 1}`)
    return turn
  }

  const build = (turn: FakeTurn, params: BetaMessageStreamParams): { message: BetaMessage; events: BetaRawMessageStreamEvent[] } => {
    const content: BetaContentBlock[] = [
      ...(turn.leading ?? []),
      { type: "thinking", thinking: "", signature: `sig-${toolIds}` } as BetaContentBlock,
    ]
    if (turn.text) content.push({ type: "text", text: turn.text, citations: null } as BetaContentBlock)
    for (const tool of turn.tools ?? []) {
      content.push({ type: "tool_use", id: tool.id ?? `toolu_${++toolIds}`, name: tool.name, input: tool.input } as BetaContentBlock)
    }
    const stop: BetaStopReason = turn.stop ?? (turn.tools?.length ? "tool_use" : "end_turn")
    const usage = {
      input_tokens: turn.usage?.input ?? 100,
      output_tokens: turn.usage?.output ?? 20,
      cache_read_input_tokens: turn.usage?.cacheRead ?? 0,
      cache_creation_input_tokens: turn.usage?.cacheWrite ?? 0,
      iterations: turn.iterations?.map((it) => ({
        type: it.type,
        model: it.model,
        input_tokens: it.input,
        output_tokens: it.output,
        cache_read_input_tokens: it.cacheRead ?? 0,
        cache_creation_input_tokens: it.cacheWrite ?? 0,
        cache_creation: null,
      })) ?? null,
    }
    const message = {
      id: `msg_fake_${calls.length + creates.length}`,
      type: "message",
      role: "assistant",
      model: turn.model ?? params.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      stop_details: stop === "refusal" ? { type: "refusal", category: turn.refusalCategory ?? null, explanation: null } : null,
      usage,
    } as unknown as BetaMessage

    const chunk = options.chunkSize ?? 8
    const events: BetaRawMessageStreamEvent[] = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } } as unknown as BetaRawMessageStreamEvent,
    ]
    content.forEach((block, index) => {
      if (block.type === "text") {
        events.push({ type: "content_block_start", index, content_block: { ...block, text: "" } } as BetaRawMessageStreamEvent)
        for (let i = 0; i < block.text.length; i += chunk) {
          events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text.slice(i, i + chunk) } } as BetaRawMessageStreamEvent)
        }
      } else if (block.type === "tool_use") {
        events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } } as BetaRawMessageStreamEvent)
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } } as BetaRawMessageStreamEvent)
      } else {
        events.push({ type: "content_block_start", index, content_block: block } as BetaRawMessageStreamEvent)
      }
      events.push({ type: "content_block_stop", index } as BetaRawMessageStreamEvent)
    })
    events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } } as unknown as BetaRawMessageStreamEvent)
    events.push({ type: "message_stop" } as BetaRawMessageStreamEvent)
    return { message, events }
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  const client: JackModelClient = {
    stream(params, streamOptions) {
      const index = calls.length
      calls.push(structuredClone(params))
      const turn = turnFor(script, params, index)
      const { message, events } = build(turn, params)
      let failed: Error | null = null
      const stream: JackModelStream = {
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            if (event.type === "message_delta" && turn.error) {
              failed = turn.error
              throw turn.error
            }
            if (options.chunkDelayMs && event.type === "content_block_delta") await sleep(options.chunkDelayMs)
            if (streamOptions?.signal?.aborted) {
              failed = new Anthropic.APIUserAbortError()
              throw failed
            }
            yield event
          }
        },
        async finalMessage() {
          if (failed ?? turn.error) throw failed ?? turn.error
          return message
        },
      }
      return stream
    },
    async create(params) {
      const index = creates.length
      creates.push(structuredClone(params))
      const turn = turnFor(createScript, params as BetaMessageStreamParams, index)
      if (turn.error) throw turn.error
      return build(turn, params as BetaMessageStreamParams).message
    },
  }

  return { client, calls, creates }
}

/** The text of the last user turn a request sent (string content or its text blocks) */
export function lastUserText(params: Pick<BetaMessageStreamParams, "messages">): string {
  const last = [...params.messages].reverse().find((m) => m.role === "user")
  if (!last) return ""
  if (typeof last.content === "string") return last.content
  return last.content.map((block) => (block.type === "text" ? block.text : "")).join("")
}
