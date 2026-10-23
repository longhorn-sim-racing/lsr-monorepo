/**
 * Test helper: a scripted stand-in for the Anthropic SDK, shaped like JackModelClient. Each call takes
 * the next turn of the script (or asks a function for it) and streams it as the real API would:
 * message_start, a thinking block, any scripted blocks (server tool calls with input_json_delta, their
 * results whole in content_block_start, cited text with citations_delta), text deltas, tool_use blocks
 * with input_json_delta, message_delta (with usage.server_tool_use), message_stop; finalMessage()
 * resolves with the assembled message. An aborted signal stops it the way the SDK does
 * (APIUserAbortError). A request the real API would reject (see requestProblem) fails with a 400 the
 * same way. No network. Not used by the app; scripts use it for dry runs.
 */
import Anthropic from "@anthropic-ai/sdk"
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import type { JackCreateOptions, JackModelClient, JackModelStream } from "./model-loop"

export type FakeToolCall = { id?: string; name: string; input: unknown }

export type FakeTurn = {
  /** Text the model writes, before any tool calls */
  text?: string
  tools?: FakeToolCall[]
  /**
   * Blocks after the thinking block and before `text` and `tools`, exactly as the API sends them: web
   * search and fetch calls and results, cited text, tool search, blocks of types the app doesn't know
   * (see fakeWebSearch, fakeWebFetch, fakeCitedText, fakeToolSearch)
   */
  blocks?: BetaContentBlock[]
  /** Defaults to tool_use when there are tools, end_turn otherwise */
  stop?: BetaStopReason
  model?: string
  refusalCategory?: "cyber" | "bio" | "frontier_llm" | "reasoning_extraction" | "general_harms" | null
  /** webSearches and webFetches (usage.server_tool_use) default to the successful search results and the fetch results in `blocks` */
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; webSearches?: number; webFetches?: number }
  /** Usage per attempt, as a refusal fallback reports it */
  iterations?: { type: "message" | "fallback_message"; model: string; input: number; output: number; cacheRead?: number; cacheWrite?: number }[]
  /** Content blocks to put first (e.g. a fallback switch point) */
  leading?: BetaContentBlock[]
  /** The message's container, as dynamic filtering's code execution reports it */
  container?: string
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
  /** The options each create call got (signal, timeout, retries) */
  const createOptions: (JackCreateOptions | undefined)[] = []
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
      ...(turn.blocks ?? []),
    ]
    if (turn.text) content.push({ type: "text", text: turn.text, citations: null } as BetaContentBlock)
    for (const tool of turn.tools ?? []) {
      content.push({ type: "tool_use", id: tool.id ?? `toolu_${++toolIds}`, name: tool.name, input: tool.input } as BetaContentBlock)
    }
    const stop: BetaStopReason = turn.stop ?? (turn.tools?.length ? "tool_use" : "end_turn")
    // A failed search isn't billed; every fetch is counted
    const searches = turn.usage?.webSearches ?? content.filter((block) => block.type === "web_search_tool_result" && Array.isArray(block.content)).length
    const fetches = turn.usage?.webFetches ?? content.filter((block) => block.type === "web_fetch_tool_result").length
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
      // Like the API, only the counter for a tool that ran
      server_tool_use: searches || fetches ? { ...(searches ? { web_search_requests: searches } : {}), ...(fetches ? { web_fetch_requests: fetches } : {}) } : null,
    }
    const message = {
      id: `msg_fake_${calls.length + creates.length}`,
      type: "message",
      role: "assistant",
      model: turn.model ?? params.model,
      container: turn.container ? { id: turn.container, expires_at: "2026-10-22T13:00:00Z", skills: null } : null,
      content,
      stop_reason: stop,
      stop_sequence: null,
      stop_details: stop === "refusal" ? { type: "refusal", category: turn.refusalCategory ?? null, explanation: null } : null,
      usage,
    } as unknown as BetaMessage

    const chunk = options.chunkSize ?? 8
    const events: BetaRawMessageStreamEvent[] = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...usage, server_tool_use: null } } } as unknown as BetaRawMessageStreamEvent,
    ]
    content.forEach((block, index) => {
      if (block.type === "text") {
        events.push({ type: "content_block_start", index, content_block: { ...block, text: "", citations: null } } as BetaRawMessageStreamEvent)
        for (const citation of block.citations ?? []) {
          events.push({ type: "content_block_delta", index, delta: { type: "citations_delta", citation } } as BetaRawMessageStreamEvent)
        }
        for (let i = 0; i < block.text.length; i += chunk) {
          events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text.slice(i, i + chunk) } } as BetaRawMessageStreamEvent)
        }
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } } as BetaRawMessageStreamEvent)
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } } as BetaRawMessageStreamEvent)
      } else {
        // Server tool results (and anything else) arrive whole
        events.push({ type: "content_block_start", index, content_block: block } as BetaRawMessageStreamEvent)
      }
      events.push({ type: "content_block_stop", index } as BetaRawMessageStreamEvent)
    })
    events.push({
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens, server_tool_use: usage.server_tool_use },
    } as unknown as BetaRawMessageStreamEvent)
    events.push({ type: "message_stop" } as BetaRawMessageStreamEvent)
    return { message, events }
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  const client: JackModelClient = {
    stream(params, streamOptions) {
      const index = calls.length
      calls.push(structuredClone(params))
      const problem = requestProblem(params)
      if (problem) return rejected(problem)
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
    async create(params, createOptions_) {
      if (createOptions_?.signal?.aborted) throw new Anthropic.APIUserAbortError()
      const index = creates.length
      creates.push(structuredClone(params))
      createOptions.push(createOptions_)
      const problem = requestProblem(params as BetaMessageStreamParams)
      if (problem) throw badRequest(problem)
      const turn = turnFor(createScript, params as BetaMessageStreamParams, index)
      if (turn.error) throw turn.error
      return build(turn, params as BetaMessageStreamParams).message
    },
  }

  return { client, calls, creates, createOptions }
}

function badRequest(message: string) {
  return new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message } }, message, new Headers())
}

/** A stream that fails before its first event, as the SDK's does when the API rejects the request */
function rejected(problem: string): JackModelStream {
  const error = badRequest(problem)
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
    async finalMessage() {
      throw error
    },
  }
}

type AnyBlock = BetaContentBlock | BetaContentBlockParam

/**
 * Why the real API would reject this request (a 400), or null. Checks what Jack 2.0's model loop could
 * get wrong: tool search and deferral, url_sources, documents (a Files API id in the wrong block type,
 * citations on some documents but not all), server tool calls and results sent back (each result after
 * its call, search results byte for byte, nothing but tool results while a server call is still
 * running), no tool_result for a server call, and forced tool_choice on the 5.5 models that refuse it
 */
export function requestProblem(params: BetaMessageStreamParams): string | null {
  type ToolDef = {
    name?: string
    defer_loading?: boolean
    cache_control?: unknown
    allowed_domains?: unknown
    blocked_domains?: unknown
    url_sources?: Record<string, { tools?: { name: string }[] } | undefined>
  }
  const tools = (params.tools ?? []) as ToolDef[]
  const names = new Set(tools.map((tool) => tool.name))
  if (tools.length && tools.every((tool) => tool.defer_loading)) return "At least one tool must have defer_loading=false."
  for (const tool of tools) {
    if (tool.defer_loading && tool.cache_control) return `Tool '${tool.name}' can't have cache_control: it's deferred.`
    if (tool.allowed_domains && tool.blocked_domains) return `Tool '${tool.name}' can't have both allowed_domains and blocked_domains.`
    for (const filter of Object.values(tool.url_sources ?? {})) {
      for (const ref of filter?.tools ?? []) if (!names.has(ref.name)) return `url_sources names '${ref.name}', which isn't in tools.`
    }
  }
  if ((params.tool_choice?.type === "any" || params.tool_choice?.type === "tool") && /^claude-(opus|sonnet)-5-5/.test(params.model)) {
    return `tool_choice: type "tool" and "any" are not supported for this model.`
  }

  // Documents and images anywhere in the conversation: in user turns, tool results and fetched pages
  const media: { type: string; source?: { type?: string; file_id?: string }; citations?: { enabled?: boolean } | null }[] = []
  const collect = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return
    for (const block of blocks as { type?: string; content?: unknown }[]) {
      if (block?.type === "document" || block?.type === "image") media.push(block as (typeof media)[number])
      else if (block?.type === "tool_result") collect(block.content)
      else if (block?.type === "web_fetch_tool_result") collect([(block.content as { content?: unknown } | null)?.content])
    }
  }
  for (const message of params.messages) collect(message.content)
  for (const block of media) {
    const id = block.source?.type === "file" ? (block.source.file_id ?? "") : ""
    if (block.type === "document" && id.includes("_image_")) return `File ${id} is an image: send it in an image block, not a document block.`
    if (block.type === "image" && id.includes("_pdf_")) return `File ${id} is a PDF: send it in a document block, not an image block.`
  }
  const documents = media.filter((block) => block.type === "document")
  if (new Set(documents.map((block) => block.citations?.enabled === true)).size > 1) return "Citations must be enabled on all of the documents or none of them."

  const serverCalls = new Set<string>()
  let running: string[] = []
  for (const message of params.messages) {
    const content: AnyBlock[] = typeof message.content === "string" ? [] : message.content
    if (message.role === "user") {
      for (const block of content) {
        if (block.type === "tool_result" && serverCalls.has(block.tool_use_id)) return `tool_result ${block.tool_use_id} answers a server tool call.`
      }
      if (running.length && content.some((block) => block.type !== "tool_result")) return "While a server tool call is still running, the next user turn can hold only tool_result blocks."
      running = []
      continue
    }
    const answered = new Set<string>()
    for (const block of content) {
      if (block.type === "server_tool_use") serverCalls.add(block.id)
      const result = block.type !== "tool_result" && "tool_use_id" in block ? block.tool_use_id : null
      if (typeof result === "string") {
        if (!serverCalls.has(result)) return `${block.type} ${result} has no server_tool_use before it.`
        answered.add(result)
      }
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const page of block.content) if (page.encrypted_content !== fakeEncrypted(page.url)) return `encrypted_content of ${page.url} was changed.`
      }
      if (block.type === "tool_search_tool_result" && "tool_references" in block.content) {
        for (const ref of block.content.tool_references) if (!names.has(ref.tool_name)) return `Tool reference '${ref.tool_name}' not found in available tools`
      }
    }
    // A mixed turn: its server calls without results finish first thing in the next response
    running = content.flatMap((block) => (block.type === "server_tool_use" && !answered.has(block.id) ? [block.id] : []))
  }
  return null
}

/*
 * Scripted server tool blocks, shaped as the API sends them (docs/jack-2/research/anthropic-tools.md §3).
 * Ids are srvtoolu_ ids; search results and citations carry stand-in encrypted values that requestProblem
 * checks come back unchanged.
 */

let serverIds = 0
const serverId = () => `srvtoolu_fake_${++serverIds}`
let fileIds = 0

/**
 * A stand-in Claude Files API id for a PDF or an image. The kind is in the id, so requestProblem can
 * reject a block of the wrong type the way the API does (it checks the file's MIME type)
 */
export function fakeFileId(kind: "pdf" | "image"): string {
  return `file_fake_${kind}_${++fileIds}`
}

/** The stand-in for an encrypted_content or encrypted_index value */
export function fakeEncrypted(seed: string): string {
  return `enc_${Buffer.from(seed).toString("base64url")}`
}

export type FakePage = { url: string; title?: string }
/** Where a call came from: dynamic filtering's code execution makes nested calls */
type FakeCaller = { caller?: { type: "code_execution_20260120"; tool_id: string } }

/** A web search: its call, then its result (the pages, or an error object with the code) */
export function fakeWebSearch(query: string, results: FakePage[] | { error: string }, options: { id?: string } & FakeCaller = {}): BetaContentBlock[] {
  const id = options.id ?? serverId()
  const caller = options.caller ? { caller: options.caller } : {}
  const content =
    "error" in results
      ? { type: "web_search_tool_result_error", error_code: results.error }
      : results.map((page) => ({ type: "web_search_result", url: page.url, title: page.title ?? page.url, encrypted_content: fakeEncrypted(page.url), page_age: null }))
  return [
    { type: "server_tool_use", id, name: "web_search", input: { query }, ...caller },
    { type: "web_search_tool_result", tool_use_id: id, content, ...caller },
  ] as unknown as BetaContentBlock[]
}

/** A web fetch: its call, then its result (the page as a text document, or an error object with the code) */
export function fakeWebFetch(url: string, page: { title?: string; text?: string } | { error: string }, options: { id?: string } & FakeCaller = {}): BetaContentBlock[] {
  const id = options.id ?? serverId()
  const caller = options.caller ? { caller: options.caller } : {}
  const content =
    "error" in page
      ? { type: "web_fetch_tool_result_error", error_code: page.error }
      : {
          type: "web_fetch_result",
          url,
          retrieved_at: "2026-10-22T12:00:00Z",
          content: { type: "document", source: { type: "text", media_type: "text/plain", data: page.text ?? "The page's text." }, title: page.title ?? null, citations: null },
        }
  return [
    { type: "server_tool_use", id, name: "web_fetch", input: { url }, ...caller },
    { type: "web_fetch_tool_result", tool_use_id: id, content, ...caller },
  ] as unknown as BetaContentBlock[]
}

/** A stretch of text citing search results: its own text block, with web_search_result_location citations */
export function fakeCitedText(text: string, pages: FakePage[]): BetaContentBlock {
  return {
    type: "text",
    text,
    citations: pages.map((page) => ({
      type: "web_search_result_location",
      url: page.url,
      title: page.title ?? null,
      cited_text: text.slice(0, 150),
      encrypted_index: fakeEncrypted(`index:${page.url}`),
    })),
  } as BetaContentBlock
}

/** A tool search (BM25): its call, then the tools it found */
export function fakeToolSearch(query: string, toolNames: string[], options: { id?: string } = {}): BetaContentBlock[] {
  const id = options.id ?? serverId()
  return [
    { type: "server_tool_use", id, name: "tool_search_tool_bm25", input: { query } },
    { type: "tool_search_tool_result", tool_use_id: id, content: { type: "tool_search_tool_search_result", tool_references: toolNames.map((tool_name) => ({ type: "tool_reference", tool_name })) } },
  ] as unknown as BetaContentBlock[]
}

/**
 * A stand-in for the API's BM25 search over a request's deferred tools: the deferred tools whose name
 * or description shares a word with the query, most shared words first (ties in tools order)
 */
export function searchDeferredTools(params: Pick<BetaMessageStreamParams, "tools">, query: string, limit = 5): string[] {
  const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2))
  const wanted = words(query)
  return ((params.tools ?? []) as { name: string; description?: string; defer_loading?: boolean }[])
    .filter((tool) => tool.defer_loading)
    .map((tool, order) => ({ name: tool.name, order, score: [...words(`${tool.name.replace(/_/g, " ")} ${tool.description ?? ""}`)].filter((word) => wanted.has(word)).length }))
    .filter((tool) => tool.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((tool) => tool.name)
}

/** The text of the last user turn a request sent (string content or its text blocks) */
export function lastUserText(params: Pick<BetaMessageStreamParams, "messages">): string {
  const last = [...params.messages].reverse().find((m) => m.role === "user")
  if (!last) return ""
  if (typeof last.content === "string") return last.content
  return last.content.map((block) => (block.type === "text" ? block.text : "")).join("")
}
