import Anthropic from "@anthropic-ai/sdk"
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaRequestDocumentBlock,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { z } from "zod"
import type { JackToolPart } from "@/lib/jack/parts"
import { JACK_PERSONA_NAME } from "@/lib/jack/types"
import { UsageTally } from "./cost"
import { SERVER_FALLBACK_BETA, THINKING_BINDING_BETA, type JackModelConfig } from "./models"
import type { AnyJackTool, JackModelDocument, JackModelImage, JackRequestType, JackToolContext } from "./tools/types"
import {
  addCitations,
  addLinkedPages,
  isWebCall,
  pendingServerCalls,
  recordWebResult,
  SERVER_TOOL_NAMES,
  TOOL_SEARCH_TOOL,
  webPartFields,
  webServerTools,
  webToolsOn,
  type WebCall,
} from "./web-tools"

/** What the loop needs from the Anthropic SDK: a streamed call (replies) and a plain one (Stand). Tests pass a fake */
export type JackModelStream = AsyncIterable<BetaRawMessageStreamEvent> & { finalMessage(): Promise<BetaMessage> }
/** For a plain call: cancel it, cap each attempt's time, and how many times the SDK may retry it */
export type JackCreateOptions = { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number }
export type JackModelClient = {
  stream(params: BetaMessageStreamParams, options?: { signal?: AbortSignal }): JackModelStream
  create(params: MessageCreateParamsNonStreaming, options?: JackCreateOptions): Promise<BetaMessage>
}

/** The real client. The SDK retries 429s, 5xx and dropped connections twice before a call fails */
export function anthropicJackClient(apiKey: string): JackModelClient {
  const client = new Anthropic({ apiKey })
  return {
    stream: (params, options) => client.beta.messages.stream(params, { signal: options?.signal }),
    create: (params, options) =>
      client.beta.messages.create(params, { signal: options?.signal, timeout: options?.timeoutMs, maxRetries: options?.maxRetries }),
  }
}

export type ReplyLimits = {
  /** Tool calls per reply; after that the model is told to answer with what it has */
  maxToolCalls: number
  /** Output tokens (thinking included) across the reply's calls before it's told to wrap up */
  maxOutputTokens: number
  /**
   * The same two limits once the reply calls a deck tool (#177): a deck takes a dozen or more calls
   * (the guide, photos, writes, checks, a render, fixes) and writes a lot of HTML
   */
  maxDesignToolCalls: number
  maxDesignOutputTokens: number
  /** Wall time before a design reply is told to wrap up: its hand-off note is short, so it can work longer */
  maxDesignElapsedMs: number
  /** Wall time before it's told to wrap up, well inside the function's maxDuration */
  maxElapsedMs: number
  toolTimeoutMs: number
  /** Re-issues of a call whose streamed tool input wasn't JSON at all */
  maxJsonRetries: number
  /**
   * Web searches and pages opened per reply, counted from each call's `usage.server_tool_use`; then it's
   * told to wrap up. A soft cap: it's checked when a call ends, and each call has its own (WEB_LIMITS'
   * max_uses, 5 searches and 3 pages), so the call that crosses it can go up to 12 searches and 7 pages.
   * When it's crossed in a turn still waiting on a web call, the note waits for a call that ends with none
   * pending, and each call before it can add its share
   */
  maxWebSearches: number
  maxWebFetches: number
}

export const REPLY_LIMITS: ReplyLimits = {
  maxToolCalls: 12,
  maxOutputTokens: 64_000,
  maxDesignToolCalls: 30,
  maxDesignOutputTokens: 120_000,
  maxDesignElapsedMs: 200_000,
  maxElapsedMs: 150_000,
  toolTimeoutMs: 45_000,
  maxJsonRetries: 2,
  maxWebSearches: 8,
  maxWebFetches: 5,
}

/** What the model reads back from one tool call, at most */
const MAX_TOOL_RESULT_CHARS = 30_000
/** A failed call's message as the room shows it, at most */
const MAX_PART_ERROR_CHARS = 2_000

export type ModelReplyOptions = {
  client: JackModelClient
  config: JackModelConfig
  system: BetaTextBlockParam[]
  tools: AnyJackTool[]
  /** The room so far, ending with the officer turn being answered (history.ts) */
  history: BetaMessageParam[]
  ctx: JackToolContext
  /** Streams text to the room as it's written */
  onText: (text: string) => void
  /**
   * The reply took back text that already streamed (a declined partial, or a call that came through
   * garbled and is asked again): its text is now `text`, which viewers should show instead. Parts placed
   * past the new end follow as part updates
   */
  onReset?: (text: string) => void
  /** A tool call started or changed. Calls arrive in order; the caller saves and broadcasts the part */
  onPart: (part: JackToolPart, parts: JackToolPart[]) => Promise<void>
  /**
   * After each Claude call is added to `usage` (one that failed partway counts what it reported before
   * failing), so the caller can save the spend as it goes rather than only at the end
   */
  onUsage?: (usage: UsageTally) => Promise<void>
  limits?: Partial<ReplyLimits>
  /**
   * What the reply is for. Room replies get web search and fetch when JACK_WEB_TOOLS=on; scheduled runs
   * (recurring questions, digest summaries) never do (design §7.2). Required, so no caller gets the web
   * tools by leaving it out
   */
  requestType: JackRequestType
  /** Cancels the reply: aborts the Claude call in flight and any tool that's running */
  signal?: AbortSignal
  /** Where the calls' token usage adds up; pass one in to read it even if the reply throws */
  usage?: UsageTally
  now?: () => number
}

export type ReplyOutcome = "answered" | "refusal" | "cut_off" | "tool_limit" | "api_error" | "bad_tool_input"

export type ModelReplyResult = {
  /** The reply's final text. Can differ from what streamed (a declined partial is dropped); the done event carries this */
  text: string
  parts: JackToolPart[]
  /** error only when the reply truly failed (Claude unreachable, the request rejected) */
  status: "done" | "error"
  outcome: ReplyOutcome
  usage: UsageTally
  toolCalls: number
  /** The reply called a deck tool (#177) */
  design: boolean
  /** It was told to stop and wrap up (tool calls, output or time ran out) rather than finishing on its own */
  wrappedUp: boolean
}

/**
 * One reply: streams Claude's answer, runs the tools it calls, and loops until it's done.
 *
 * The request is tools, then the system prompt (one cache breakpoint at its end), then the history,
 * with automatic caching on the growing tail. Within a reply the conversation is append-only: each
 * assistant turn goes back exactly as it came (thinking blocks, server tool calls and results, and
 * any block type this code doesn't know included), followed by its tool results, so the cached prefix
 * and the thinking blocks stay valid from call to call.
 *
 * Web search and fetch (server tools) run inside a call. Each becomes a part with a web_sources display,
 * filled in with the pages the reply cites as the citations stream in (citations_delta).
 */
export async function runModelReply(options: ModelReplyOptions): Promise<ModelReplyResult> {
  const { client, config, system, onText } = options
  const limits = { ...REPLY_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const name = JACK_PERSONA_NAME[config.persona]
  const { requestType } = options
  const ctx: JackToolContext = { ...options.ctx, requestType }
  const { offered: tools, defs: toolDefs } = requestTools(options.tools, { web: requestType === "room" && webToolsOn() })
  const usage = options.usage ?? new UsageTally(config.model)
  const messages: BetaMessageParam[] = [...options.history]
  const started = now()
  // Dynamic filtering runs code in a container; later calls in the reply name it to carry on there
  let container: string | null = null

  let text = ""
  const parts: JackToolPart[] = []
  // Tools read the reply's calls from here (knowledge provenance): the copy saved on the reply lags behind
  if (ctx.reply) ctx.reply.toolParts = () => parts
  let partChain: Promise<void> = Promise.resolve()
  // Web searches and fetches in this reply, in the order they started, and the pages its text cites
  const webCalls = new Map<string, WebCall>()
  const cited = new Map<string, string | null>()
  let toolCalls = 0
  let wrapUp = false
  let jsonRetries = 0
  // Set once the reply calls a deck tool; from then on it has the design limits
  let design = false
  const toolCap = () => (design ? limits.maxDesignToolCalls : limits.maxToolCalls)
  const outputCap = () => (design ? limits.maxDesignOutputTokens : limits.maxOutputTokens)
  const elapsedCap = () => (design ? limits.maxDesignElapsedMs : limits.maxElapsedMs)

  const say = (piece: string) => {
    if (!piece) return
    text += piece
    onText(piece)
  }
  /** Drops the text after `length` and tells the room; parts placed past the new end move to it */
  const takeBack = (length: number) => {
    if (text.length <= length) return
    text = text.slice(0, length)
    options.onReset?.(text)
    for (const part of parts) if (part.at > text.length) upsertPart({ ...part, at: text.length })
  }
  /** Counts a call's tokens and lets the caller save them. Never throws */
  const countUsage = async (message: Pick<BetaMessage, "model" | "usage">) => {
    usage.add(message)
    try {
      await options.onUsage?.(usage)
    } catch (error) {
      console.error(`[jack] Couldn't record usage in room ${ctx.roomId}:`, error)
    }
  }
  const finishWith = (note: string) => say(`${text.trim() ? "\n\n" : ""}${note}`)
  const upsertPart = (part: JackToolPart) => {
    const index = parts.findIndex((p) => p.id === part.id)
    if (index === -1) parts.push(part)
    else parts[index] = part
    const snapshot = parts.slice()
    partChain = partChain.then(() =>
      options.onPart(part, snapshot).catch((error) => console.error(`[jack] Couldn't save tool part ${part.id}:`, error))
    )
  }
  /** Ends a part that's still running as an error; a web call without its result is dropped too, so it isn't shown as running again */
  const closePart = (part: JackToolPart, label: string) => {
    if (!webCalls.get(part.id)?.found) webCalls.delete(part.id)
    upsertPart({ ...part, status: "error", label, error: label, at: Math.min(part.at, text.length) })
  }
  const closeOpenParts = (label: string) => {
    for (const part of parts) if (part.status === "running") closePart(part, label)
  }
  const result = async (status: "done" | "error", outcome: ReplyOutcome): Promise<ModelReplyResult> => {
    await partChain
    return { text, parts, status, outcome, usage, toolCalls, design, wrappedUp: wrapUp }
  }

  /** Brings the web calls' parts up to date: new ones placed at the text so far, changed ones sent again */
  const refreshWebParts = () => {
    for (const [id, fields] of webPartFields(webCalls.values(), cited)) {
      const current = parts.find((part) => part.id === id)
      const next: JackToolPart = { ...(current ?? { id, at: text.length }), ...fields }
      if (!current || JSON.stringify(current) !== JSON.stringify(next)) upsertPart(next)
    }
  }
  const startWebCall = (block: { id: string; name: WebCall["name"] }) => {
    if (!webCalls.has(block.id)) webCalls.set(block.id, { id: block.id, name: block.name, input: null, found: null, error: null, startedAt: now() })
  }
  /** After a call, from the turn that goes back: its web calls, their results and its citations, in case the stream left anything out */
  const syncWeb = (content: readonly BetaContentBlockParam[]) => {
    for (const block of content) {
      if (isWebCall(block)) {
        startWebCall(block)
        if (block.input && typeof block.input === "object") webCalls.get(block.id)!.input = block.input as Record<string, unknown>
      } else if (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
        const call = webCalls.get(block.tool_use_id)
        if (call && !call.found) recordWebResult(call, block, now())
      }
    }
    addCitations(cited, content)
    addLinkedPages(cited, text, webCalls.values())
    refreshWebParts()
  }
  /**
   * Why the reply should wrap up now, if it should: what the model is told (`note`), and what the room is
   * told it ran out of (`used`) when it has to stop instead
   */
  const wrapUpReason = (): { note: string; used: string } | null => {
    if (toolCalls >= toolCap()) return { note: `You've used this reply's ${toolCap()} tool calls.`, used: "used up its tool calls" }
    if (usage.webSearches >= limits.maxWebSearches) return { note: `You've used this reply's ${limits.maxWebSearches} web searches.`, used: "used up its web searches" }
    if (usage.webFetches >= limits.maxWebFetches) return { note: `You've opened this reply's ${limits.maxWebFetches} web pages.`, used: "opened all the web pages it can" }
    if (usage.tokens.outputTokens >= outputCap() || now() - started >= elapsedCap()) return { note: "This reply is running long.", used: "ran long" }
    return null
  }
  const wrapUpNote = (reason: { note: string }) =>
    design
      ? `${reason.note} Don't call any more tools: in a few sentences, say what's done (with the deck's link) and what's left. You'll pick it up in your next reply.`
      : `${reason.note} Don't call any more tools: answer now with what you have, and say what you couldn't check.`

  for (let call = 0; call < Math.max(limits.maxToolCalls, limits.maxDesignToolCalls) + 4; call++) {
    const textBefore = text.length
    let message: BetaMessage
    // What the call has reported about its usage so far, for a call that fails partway
    const seen = new PartialUsage()
    // A web call's input as it streams, by block index, so its part can say what it's looking for
    const webInputs = new Map<number, { id: string; json: string }>()
    let previous: string | null = null
    try {
      const stream = client.stream(buildParams(config, system, toolDefs, messages, wrapUp, container), { signal: options.signal })
      for await (const event of stream) {
        seen.track(event)
        if (event.type === "content_block_start") {
          const block = event.content_block
          if (block.type === "text") {
            // Text right after text is the same passage: with citations, each cited stretch is its own block
            if (previous !== "text" && text && !text.endsWith("\n")) say("\n\n")
            say(block.text)
          } else if (block.type === "tool_use") {
            upsertPart({ id: block.id, name: block.name, label: `Using ${block.name}`, status: "running", at: text.length, input: null, displays: [] })
          } else if (isWebCall(block)) {
            startWebCall(block)
            webInputs.set(event.index, { id: block.id, json: "" })
            refreshWebParts()
          } else if (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
            // Server tool results arrive whole, when the search or fetch is done
            const webCall = webCalls.get(block.tool_use_id)
            if (webCall) {
              recordWebResult(webCall, block, now())
              refreshWebParts()
            }
          } else if (block.type === "fallback") {
            console.info(`[jack] ${block.from.model} declined in room ${ctx.roomId}; ${block.to.model} continued`)
          }
          previous = block.type
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") say(event.delta.text)
          else if (event.delta.type === "input_json_delta") {
            const input = webInputs.get(event.index)
            if (input) input.json += event.delta.partial_json
          } else if (event.delta.type === "citations_delta") {
            // A cited page shows under its search as soon as the text citing it streams
            const citation = event.delta.citation
            if (citation.type === "web_search_result_location" && !cited.has(citation.url)) {
              cited.set(citation.url, citation.title ?? null)
              refreshWebParts()
            }
          }
        } else if (event.type === "content_block_stop") {
          const input = webInputs.get(event.index)
          const webCall = input && webCalls.get(input.id)
          if (input && webCall && !webCall.input) {
            webCall.input = parseObject(input.json)
            refreshWebParts()
          }
          webInputs.delete(event.index)
        }
      }
      message = await stream.finalMessage()
    } catch (error) {
      // The call is billed for what it got through, so count what it reported
      const partial = seen.message()
      if (partial) await countUsage(partial)
      if (error instanceof Anthropic.APIError) {
        console.error(`[jack] Claude call failed in room ${ctx.roomId}:`, error)
        closeOpenParts("Didn't run: Claude stopped answering")
        finishWith(apiErrorMessage(error, name))
        return result("error", "api_error")
      }
      // With eager input streaming the SDK parses each tool input when its block closes; input that
      // isn't JSON at all fails the stream. There's no tool_use id to answer, so re-issue the call.
      // The call's text goes too, for viewers as well: the re-issued call writes its own
      console.error(`[jack] A streamed tool input wasn't valid JSON in room ${ctx.roomId}:`, error)
      takeBack(textBefore)
      closeOpenParts("Didn't run: the call came through garbled")
      if (jsonRetries++ < limits.maxJsonRetries) continue
      finishWith(`${name} couldn't finish this answer: Claude kept sending tool calls that weren't readable. Ask again.`)
      return result("error", "bad_tool_input")
    }
    jsonRetries = 0
    await countUsage(message)
    reportDroppedThinking(message, ctx.roomId)
    if (message.container?.id) container = message.container.id

    const echo = echoContent(message.content)
    const switchedAt = message.content.findLastIndex((block) => block.type === "fallback")
    const toolUses = message.content.slice(switchedAt + 1).filter((block): block is BetaToolUseBlock => block.type === "tool_use")
    syncWeb(echo)
    // A web call still running in a turn that also called Jack's tools finishes in the next call
    const pending = new Set(pendingServerCalls(echo))
    for (const part of parts) {
      if (part.status === "running" && !toolUses.some((use) => use.id === part.id) && !pending.has(part.id)) closePart(part, "Didn't run")
    }

    if (message.stop_reason === "refusal") {
      console.warn(`[jack] Claude declined in room ${ctx.roomId} (${message.stop_details?.category ?? "no category"})`)
      // A partial before the decline isn't a complete answer, so it goes, for viewers too
      takeBack(textBefore)
      closeOpenParts("Didn't run: the request was declined")
      // Haiku has no server-side fallback, so from Stand the way past a false refusal is Jack, which has one
      finishWith(
        `I can't help with that one: Claude's safety checks declined the request. Try asking it a different way${config.persona === "stand" ? ", or switch the room to Jack" : ""}.`
      )
      return result("done", "refusal")
    }
    if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
      // A tool input cut off at the limit can still parse as a valid partial object, so never run it
      closeOpenParts("Didn't run: the reply hit its length limit")
      finishWith(
        toolUses.length
          ? `(${name} ran out of room before finishing. Ask a narrower question${config.persona === "stand" ? ", or switch the room to Jack" : config.persona === "jack" ? ", or switch the room to Lift" : ""}.)`
          : `(This answer hit the length limit and was cut off.)`
      )
      return result("done", "cut_off")
    }
    if (message.stop_reason === "pause_turn") {
      // A long run of server tool calls paused; sending the turn back unchanged lets it carry on
      messages.push({ role: "assistant", content: echo })
      // The same limits as after a tool round: a run of pauses can't outlast the reply's time or web share
      const reason = wrapUp ? null : wrapUpReason()
      if (reason) {
        if (pending.size) {
          // Carrying on would run the pending call and maybe more; a turn with one pending can't take a wrap-up note
          closeOpenParts(`Didn't run: the reply ${reason.used}`)
          finishWith(`(${name} stopped here: this answer ${reason.used}. Ask a follow-up to keep going.)`)
          return result("done", "tool_limit")
        }
        wrapUp = true
        messages.push({ role: "user", content: [{ type: "text", text: wrapUpNote(reason) }] })
      }
      continue
    }
    if (message.stop_reason !== "tool_use" || !toolUses.length) {
      closeOpenParts("Didn't run")
      return result("done", "answered")
    }
    if (wrapUp) {
      // Told to stop and answer, it called tools anyway
      closeOpenParts("Didn't run: tool limit reached")
      finishWith(`(${name} stopped here: this answer used up its tool calls. Ask a follow-up to keep going.)`)
      return result("done", "tool_limit")
    }

    if (toolUses.some((use) => findTool(tools, use.name)?.design)) design = true
    const allowance = Math.max(0, toolCap() - toolCalls)
    const results = await Promise.all(
      toolUses.map((use, i) => (i < allowance ? runTool(use) : skipTool(use)))
    )
    toolCalls += Math.min(toolUses.length, allowance)

    const reason = wrapUpReason()
    const content: BetaContentBlockParam[] = [...results]
    // With a web call still pending, this turn may hold tool results only; the next round, once its
    // result is in, adds the note (the limits only grow, so the reason still holds then)
    if (reason && !pending.size) {
      wrapUp = true
      content.push({ type: "text", text: wrapUpNote(reason) })
    }
    messages.push({ role: "assistant", content: echo })
    messages.push({ role: "user", content })
  }

  closeOpenParts("Didn't run")
  finishWith(`(${name} stopped here: this answer took too many steps. Ask a follow-up to keep going.)`)
  return result("done", "tool_limit")

  async function runTool(use: BetaToolUseBlock): Promise<BetaToolResultBlockParam> {
    const startedAt = now()
    const base = parts.find((p) => p.id === use.id) ?? { id: use.id, name: use.name, label: `Using ${use.name}`, at: text.length, displays: [] }
    const fail = (label: string, forModel: string): BetaToolResultBlockParam => {
      upsertPart({ ...base, input: use.input, status: "error", label, error: label, displays: [], ms: now() - startedAt })
      return { type: "tool_result", tool_use_id: use.id, is_error: true, content: forModel }
    }

    const tool = findTool(tools, use.name)
    if (!tool) return fail(`No tool named ${use.name}`, `There's no tool named "${use.name}". The tools are: ${tools.map((t) => t.name).join(", ") || "none"}.`)

    // Eager input streaming means the API doesn't validate tool input, and the SDK's tolerant parser
    // can hand back a truncated object, so the input is checked against the tool's schema first
    const parsed = tool.input.safeParse(use.input)
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      return fail(`${tool.name}: invalid input`, JSON.stringify({ INVALID_JSON: JSON.stringify(use.input), problems }))
    }

    upsertPart({ ...base, name: tool.name, input: use.input, status: "running", displays: [] })
    try {
      const out = await withTimeout((signal) => tool.run(parsed.data, { ...ctx, signal }), tool.timeoutMs ?? limits.toolTimeoutMs, options.signal)
      upsertPart({
        ...base,
        name: tool.name,
        input: use.input,
        status: out.isError ? "error" : "done",
        label: out.label,
        displays: out.displays ?? [],
        // The room shows a failed call's own message (e.g. Postgres's error for a bad query)
        error: out.isError ? clip(out.forModel, MAX_PART_ERROR_CHARS) : undefined,
        ms: now() - startedAt,
      })
      return { type: "tool_result", tool_use_id: use.id, content: resultContent(out.forModel, out.images, out.documents), ...(out.isError ? { is_error: true } : {}) }
    } catch (error) {
      console.error(`[jack] Tool ${tool.name} failed in room ${ctx.roomId}:`, error)
      const reason = error instanceof Error ? error.message : String(error)
      return fail(`${tool.name} failed`, `The tool failed: ${reason}`)
    }
  }

  async function skipTool(use: BetaToolUseBlock): Promise<BetaToolResultBlockParam> {
    const base = parts.find((p) => p.id === use.id) ?? { id: use.id, name: use.name, at: text.length, displays: [] }
    const label = "Skipped: tool limit reached"
    upsertPart({ ...base, label, input: use.input, status: "error", error: label, displays: [] })
    return { type: "tool_result", tool_use_id: use.id, is_error: true, content: `Not run: this reply already used its ${toolCap()} tool calls.` }
  }
}

/**
 * The usage a streamed call reports as it goes: message_start has the input side, each message_delta
 * the output so far. For a call that fails partway; a finished call's final message has the full count
 */
class PartialUsage {
  private model: string | null = null
  private usage: BetaMessage["usage"] | null = null

  track(event: BetaRawMessageStreamEvent) {
    if (event.type === "message_start") {
      this.model = event.message.model
      this.usage = { ...event.message.usage }
    } else if (event.type === "message_delta" && this.usage) {
      const delta = event.usage
      this.usage = {
        ...this.usage,
        output_tokens: delta.output_tokens,
        input_tokens: delta.input_tokens ?? this.usage.input_tokens,
        cache_creation_input_tokens: delta.cache_creation_input_tokens ?? this.usage.cache_creation_input_tokens,
        cache_read_input_tokens: delta.cache_read_input_tokens ?? this.usage.cache_read_input_tokens,
        // Searches made before a call failed are still billed
        server_tool_use: delta.server_tool_use ?? this.usage.server_tool_use,
      }
    }
  }

  message(): Pick<BetaMessage, "model" | "usage"> | null {
    return this.model !== null && this.usage ? { model: this.model, usage: this.usage } : null
  }
}

/** Thinking and tool calls from before a mid-answer refusal fallback aren't sent back */
const DROPPED_BEFORE_FALLBACK = new Set<BetaContentBlock["type"]>(["thinking", "redacted_thinking", "tool_use", "server_tool_use"])

/**
 * A response's blocks as the next request sends them back: exactly as they came, block types this code
 * doesn't know included (dynamic filtering's code execution results). The exception is a refusal
 * fallback mid-answer: the declined model's thinking and tool calls before the switch don't go back
 * (and don't run), and neither do the results of its server tool calls, which would have no call. Its
 * text does, as context for the model that took over, without citations (they point at those results)
 */
export function echoContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const switchedAt = content.findLastIndex((block) => block.type === "fallback")
  if (switchedAt === -1) return content as BetaContentBlockParam[]
  const dropped = new Set(content.slice(0, switchedAt).flatMap((block) => (block.type === "server_tool_use" ? [block.id] : [])))
  const echo: BetaContentBlockParam[] = []
  content.forEach((block, i) => {
    if (block.type === "fallback") return
    if (i < switchedAt) {
      if (DROPPED_BEFORE_FALLBACK.has(block.type)) return
      if ("tool_use_id" in block && dropped.has(block.tool_use_id)) return
      if (block.type === "text" && block.citations?.length) {
        echo.push({ type: "text", text: block.text })
        return
      }
    }
    echo.push(block as BetaContentBlockParam)
  })
  return echo
}

function buildParams(
  config: JackModelConfig,
  system: BetaTextBlockParam[],
  tools: BetaToolUnion[],
  messages: BetaMessageParam[],
  wrapUp: boolean,
  container: string | null
): BetaMessageStreamParams {
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    // Adaptive is the only thinking mode on these models; effort is the dial. Prior replies come back
    // as text, and this reply's turns go back unchanged, so a thinking block never meets an edited
    // history. If one ever did (a bug), dropping it beats failing the reply; it's logged below.
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: config.effort },
    system,
    // tool_choice "none" stops server tools (web search and fetch) too
    ...(tools.length ? { tools, ...(wrapUp ? { tool_choice: { type: "none" as const } } : {}) } : {}),
    ...(container ? { container } : {}),
    messages: [...messages],
    // Automatic caching on the conversation tail (the system prompt carries its own breakpoint)
    cache_control: { type: "ephemeral" },
    // A refusal is retried server-side on the model Anthropic recommends for its category
    ...(config.fallbacks ? { fallbacks: "default" as const } : {}),
    betas: [...(config.fallbacks ? [SERVER_FALLBACK_BETA] : []), THINKING_BINDING_BETA],
  }
}

const toolDefinitionCache = new WeakMap<AnyJackTool[], BetaTool[]>()

/**
 * Jack's tools as the API takes them, in registry order (part of the cached prefix, so it never
 * reorders). Each streams its input as it's generated (`eager_input_streaming`); runTool validates it.
 * A deferred tool is sent with `defer_loading`: the model finds it through tool search, and it stays
 * out of the cached prefix until then. Eager input streaming and deferral are separate fields of the
 * same tool definition (SDK 0.133's BetaTool has both), and nothing in the tool search docs rules the
 * pair out
 */
export function toolDefinitions(tools: AnyJackTool[]): BetaTool[] {
  const cached = toolDefinitionCache.get(tools)
  if (cached) return cached
  const defs = tools.map((tool): BetaTool => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>
    void _ignored
    return {
      name: tool.name,
      description: tool.description,
      input_schema: { ...schema, type: "object" } as BetaTool.InputSchema,
      eager_input_streaming: true,
      ...(tool.deferred ? { defer_loading: true } : {}),
    }
  })
  toolDefinitionCache.set(tools, defs)
  return defs
}

/** The tools one request offers: the ones the model loop may run, and every definition the request sends */
export type RequestTools = { offered: AnyJackTool[]; defs: BetaToolUnion[] }

const requestToolsCache = new WeakMap<AnyJackTool[], Map<boolean, RequestTools>>()

/**
 * What a request sends as `tools`, in a fixed order (it starts the cached prefix): Jack's tools in
 * registry order, then the tool search tool when any of them is deferred, then web search and fetch
 * when `web`. Without `web`, the tools marked `web` (web_links) are left out as well. So the list
 * changes only with `web`, which is decided per request type, never partway through a conversation
 */
export function requestTools(tools: AnyJackTool[], { web }: { web: boolean }): RequestTools {
  const cached = requestToolsCache.get(tools)?.get(web)
  if (cached) return cached
  const offered = web || !tools.some((tool) => tool.web) ? tools : tools.filter((tool) => !tool.web)
  for (const tool of offered) {
    if (SERVER_TOOL_NAMES.has(tool.name)) throw new Error(`A Jack tool can't be named "${tool.name}": that's the name of one of the API's server tools`)
  }
  const client = toolDefinitions(offered)
  const defs: BetaToolUnion[] = [...client]
  if (client.some((def) => def.defer_loading)) defs.push(TOOL_SEARCH_TOOL)
  if (web) defs.push(...webServerTools(offered.map((tool) => tool.name)))
  const set = { offered, defs }
  const byWeb = requestToolsCache.get(tools) ?? new Map<boolean, RequestTools>()
  byWeb.set(web, set)
  requestToolsCache.set(tools, byWeb)
  return set
}

/** By exact name, or a case-only mismatch when there's exactly one match (models occasionally slip on case) */
function findTool(tools: AnyJackTool[], name: string): AnyJackTool | undefined {
  const exact = tools.find((tool) => tool.name === name)
  if (exact) return exact
  const loose = tools.filter((tool) => tool.name.toLowerCase() === name.toLowerCase())
  return loose.length === 1 ? loose[0] : undefined
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n[cut off at ${max} characters]` : text
}

/** Most images one tool result shows the model (a deck render's slides); each is about 1,200 to 1,800 tokens */
export const MAX_TOOL_RESULT_IMAGES = 12
/** Most documents (PDFs) one tool result shows the model; a page costs its text plus an image */
export const MAX_TOOL_RESULT_DOCUMENTS = 5

/**
 * A tool's result as the API takes it: its text clipped to MAX_TOOL_RESULT_CHARS, then any documents
 * and then any images, each after its caption (at most MAX_TOOL_RESULT_DOCUMENTS and MAX_TOOL_RESULT_IMAGES)
 */
export function resultContent(forModel: string, images: JackModelImage[] = [], documents: JackModelDocument[] = []): BetaToolResultBlockParam["content"] {
  const text = clip(forModel, MAX_TOOL_RESULT_CHARS)
  if (!images.length && !documents.length) return text
  const blocks: Exclude<BetaToolResultBlockParam["content"], string | undefined> = [{ type: "text", text: text || "(no text)" }]
  for (const document of documents.slice(0, MAX_TOOL_RESULT_DOCUMENTS)) {
    blocks.push({ type: "text", text: document.caption })
    blocks.push(documentBlock(document))
  }
  if (documents.length > MAX_TOOL_RESULT_DOCUMENTS) blocks.push({ type: "text", text: `(${documents.length - MAX_TOOL_RESULT_DOCUMENTS} more documents left out; ask for fewer at a time.)` })
  for (const image of images.slice(0, MAX_TOOL_RESULT_IMAGES)) {
    blocks.push({ type: "text", text: image.caption })
    blocks.push({ type: "image", source: "fileId" in image ? { type: "file", file_id: image.fileId } : { type: "base64", media_type: image.mediaType, data: image.data } })
  }
  if (images.length > MAX_TOOL_RESULT_IMAGES) blocks.push({ type: "text", text: `(${images.length - MAX_TOOL_RESULT_IMAGES} more images left out; ask for fewer at a time.)` })
  return blocks
}

/** A document as a `document` block: by Files API id, or base64. No citations: a request's documents have them all or none */
function documentBlock(document: JackModelDocument): BetaRequestDocumentBlock {
  const { source } = document
  return {
    type: "document",
    source: source.type === "file" ? { type: "file", file_id: source.fileId } : { type: "base64", media_type: source.mediaType, data: source.data },
    ...(document.title ? { title: document.title } : {}),
  }
}

/** A streamed tool input as an object, or null when it isn't one */
function parseObject(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Runs a tool with an AbortSignal (passed on as ctx.signal) that fires when the tool runs past `ms`
 * or the reply is cancelled; either way the call fails rather than waiting on the tool.
 */
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, cancel?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onCancel: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    const stop = (reason: string) => {
      controller.abort(new Error(reason))
      reject(new Error(reason))
    }
    timer = setTimeout(() => stop(`timed out after ${Math.round(ms / 1000)} s`), ms)
    onCancel = () => stop("the reply was cancelled")
    if (cancel?.aborted) onCancel()
    else cancel?.addEventListener("abort", onCancel, { once: true })
  })
  try {
    return await Promise.race([work(controller.signal), stopped])
  } finally {
    clearTimeout(timer)
    if (onCancel) cancel?.removeEventListener("abort", onCancel)
  }
}

/** Logs thinking blocks the API dropped. A prefix mismatch means the history was edited mid-reply (a bug) */
function reportDroppedThinking(message: BetaMessage, roomId: string) {
  const dropped = (message as { input_transformations?: { type?: string; reason?: string; path?: string }[] }).input_transformations
  if (!Array.isArray(dropped) || !dropped.length) return
  for (const entry of dropped) {
    const log = entry.reason === "prefix_binding_mismatch" ? console.warn : console.info
    log(`[jack] Thinking block ${entry.type ?? "?"} at ${entry.path ?? "?"} in room ${roomId}: ${entry.reason ?? "?"}`)
  }
}

/**
 * The Anthropic account's spend limits, none of which clears up by asking again: a limit set in the
 * Console is a 400 whose message starts "You have reached your specified API usage limits" (the org's)
 * or "You have reached your specified workspace API usage limits" (a workspace's), and the usage tier's
 * cap is a 429 with error_code enforced_spend_limit_reached
 */
export function isSpendLimitError(error: InstanceType<typeof Anthropic.APIError>): boolean {
  const body = (error.error ?? null) as { error?: { message?: unknown; details?: { error_code?: unknown } }; details?: { error_code?: unknown } } | null
  const message = [typeof body?.error?.message === "string" ? body.error.message : "", error.message].join("\n")
  const code = body?.error?.details?.error_code ?? body?.details?.error_code
  return message.includes("You have reached your specified") || code === "enforced_spend_limit_reached" || message.includes("enforced_spend_limit_reached")
}

/** What the room sees when Claude can't be reached or rejects the call (typed SDK errors, most specific first) */
export function apiErrorMessage(error: InstanceType<typeof Anthropic.APIError>, name: string): string {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
    return `${name} can't reach Claude: the API key was rejected. An admin needs to check ANTHROPIC_API_KEY.`
  if (isSpendLimitError(error))
    return `Claude turned this request down: the Anthropic account has reached its spend limit. ${name} can't answer until an admin raises the limit in the Anthropic Console, or it resets next month.`
  if (error instanceof Anthropic.RateLimitError) return `Claude is getting too many requests right now. Ask again in a minute.`
  if (error.status === 402)
    return `Claude turned this request down for billing: the Anthropic account may have hit its spend limit. An admin needs to check the Anthropic Console.`
  if (error instanceof Anthropic.InternalServerError) return `Claude is having trouble right now (server error ${error.status}). Ask again in a few minutes.`
  if (error instanceof Anthropic.APIConnectionError) return `${name} couldn't reach Claude (network error). Ask again in a minute.`
  if (error instanceof Anthropic.APIUserAbortError) return `This answer was stopped before it finished.`
  return `Claude rejected the request${error.status ? ` (error ${error.status})` : ""}. That's a bug in ${name}; tell the tech team.`
}
