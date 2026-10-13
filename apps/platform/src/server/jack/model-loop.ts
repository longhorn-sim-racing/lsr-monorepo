import Anthropic from "@anthropic-ai/sdk"
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { z } from "zod"
import type { JackToolPart } from "@/lib/jack/parts"
import { JACK_PERSONA_NAME } from "@/lib/jack/types"
import { UsageTally } from "./cost"
import { SERVER_FALLBACK_BETA, THINKING_BINDING_BETA, type JackModelConfig } from "./models"
import type { AnyJackTool, JackToolContext } from "./tools/types"

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
  /** Wall time before it's told to wrap up, well inside the function's maxDuration */
  maxElapsedMs: number
  toolTimeoutMs: number
  /** Re-issues of a call whose streamed tool input wasn't JSON at all */
  maxJsonRetries: number
}

export const REPLY_LIMITS: ReplyLimits = {
  maxToolCalls: 12,
  maxOutputTokens: 64_000,
  maxElapsedMs: 150_000,
  toolTimeoutMs: 45_000,
  maxJsonRetries: 2,
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
}

/**
 * One reply: streams Claude's answer, runs the tools it calls, and loops until it's done.
 *
 * The request is tools, then the system prompt (one cache breakpoint at its end), then the history,
 * with automatic caching on the growing tail. Within a reply the conversation is append-only: each
 * assistant turn goes back exactly as it came (thinking blocks included), followed by its tool
 * results, so the cached prefix and the thinking blocks stay valid from call to call.
 */
export async function runModelReply(options: ModelReplyOptions): Promise<ModelReplyResult> {
  const { client, config, system, ctx, onText } = options
  const limits = { ...REPLY_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const name = JACK_PERSONA_NAME[config.persona]
  const tools = options.tools
  const toolDefs = toolDefinitions(tools)
  const usage = options.usage ?? new UsageTally(config.model)
  const messages: BetaMessageParam[] = [...options.history]
  const started = now()

  let text = ""
  const parts: JackToolPart[] = []
  let partChain: Promise<void> = Promise.resolve()
  let toolCalls = 0
  let wrapUp = false
  let jsonRetries = 0

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
  const closeOpenParts = (label: string) => {
    for (const part of parts) {
      if (part.status === "running") upsertPart({ ...part, status: "error", label, error: label, at: Math.min(part.at, text.length) })
    }
  }
  const result = async (status: "done" | "error", outcome: ReplyOutcome): Promise<ModelReplyResult> => {
    await partChain
    return { text, parts, status, outcome, usage, toolCalls }
  }

  for (let call = 0; call < limits.maxToolCalls + 4; call++) {
    const textBefore = text.length
    let message: BetaMessage
    // What the call has reported about its usage so far, for a call that fails partway
    const seen = new PartialUsage()
    try {
      const stream = client.stream(buildParams(config, system, toolDefs, messages, wrapUp), { signal: options.signal })
      for await (const event of stream) {
        seen.track(event)
        if (event.type === "content_block_start") {
          const block = event.content_block
          if (block.type === "text") {
            if (text && !text.endsWith("\n")) say("\n\n")
            say(block.text)
          } else if (block.type === "tool_use") {
            upsertPart({ id: block.id, name: block.name, label: `Using ${block.name}`, status: "running", at: text.length, input: null, displays: [] })
          } else if (block.type === "fallback") {
            console.info(`[jack] ${block.from.model} declined in room ${ctx.roomId}; ${block.to.model} continued`)
          }
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          say(event.delta.text)
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

    // After a refusal fallback mid-answer, the declined model's thinking and tool calls before the
    // switch don't go back (and don't run); its text does, as context for the model that took over
    const switchedAt = message.content.findLastIndex((block) => block.type === "fallback")
    const echo = message.content.filter(
      (block, i) => block.type !== "fallback" && (i > switchedAt || !DROPPED_BEFORE_FALLBACK.has(block.type))
    ) as BetaContentBlockParam[]
    const toolUses = message.content.slice(switchedAt + 1).filter((block): block is BetaToolUseBlock => block.type === "tool_use")
    for (const part of parts) {
      if (part.status === "running" && !toolUses.some((use) => use.id === part.id)) upsertPart({ ...part, status: "error", label: "Didn't run", error: "Didn't run" })
    }

    if (message.stop_reason === "refusal") {
      console.warn(`[jack] Claude declined in room ${ctx.roomId} (${message.stop_details?.category ?? "no category"})`)
      // A partial before the decline isn't a complete answer, so it goes, for viewers too
      takeBack(textBefore)
      closeOpenParts("Didn't run: the request was declined")
      finishWith(`I can't help with that one: Claude's safety checks declined the request. Try asking it a different way.`)
      return result("done", "refusal")
    }
    if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
      // A tool input cut off at the limit can still parse as a valid partial object, so never run it
      closeOpenParts("Didn't run: the reply hit its length limit")
      finishWith(
        toolUses.length
          ? `(${name} ran out of room before finishing. Ask a narrower question, or switch the room to Lift.)`
          : `(This answer hit the length limit and was cut off.)`
      )
      return result("done", "cut_off")
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: echo })
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

    const allowance = Math.max(0, limits.maxToolCalls - toolCalls)
    const results = await Promise.all(
      toolUses.map((use, i) => (i < allowance ? runTool(use) : skipTool(use)))
    )
    toolCalls += Math.min(toolUses.length, allowance)

    const reason =
      toolCalls >= limits.maxToolCalls
        ? `You've used this reply's ${limits.maxToolCalls} tool calls.`
        : usage.tokens.outputTokens >= limits.maxOutputTokens || now() - started >= limits.maxElapsedMs
          ? "This reply is running long."
          : null
    const content: BetaContentBlockParam[] = [...results]
    if (reason) {
      wrapUp = true
      content.push({ type: "text", text: `${reason} Don't call any more tools: answer now with what you have, and say what you couldn't check.` })
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
      const out = await withTimeout((signal) => tool.run(parsed.data, { ...ctx, signal }), limits.toolTimeoutMs, options.signal)
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
      return { type: "tool_result", tool_use_id: use.id, content: clip(out.forModel, MAX_TOOL_RESULT_CHARS), ...(out.isError ? { is_error: true } : {}) }
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
    return { type: "tool_result", tool_use_id: use.id, is_error: true, content: `Not run: this reply already used its ${limits.maxToolCalls} tool calls.` }
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
      }
    }
  }

  message(): Pick<BetaMessage, "model" | "usage"> | null {
    return this.model !== null && this.usage ? { model: this.model, usage: this.usage } : null
  }
}

/** Thinking and tool calls from before a mid-answer refusal fallback aren't sent back */
const DROPPED_BEFORE_FALLBACK = new Set<BetaContentBlock["type"]>(["thinking", "redacted_thinking", "tool_use", "server_tool_use"])

function buildParams(
  config: JackModelConfig,
  system: BetaTextBlockParam[],
  tools: BetaTool[],
  messages: BetaMessageParam[],
  wrapUp: boolean
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
    ...(tools.length ? { tools, ...(wrapUp ? { tool_choice: { type: "none" as const } } : {}) } : {}),
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
 * The tools as the API takes them, in registry order (part of the cached prefix, so it never
 * reorders). Each streams its input as it's generated (`eager_input_streaming`); runTool validates it.
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
    }
  })
  toolDefinitionCache.set(tools, defs)
  return defs
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

/** What the room sees when Claude can't be reached or rejects the call (typed SDK errors, most specific first) */
export function apiErrorMessage(error: InstanceType<typeof Anthropic.APIError>, name: string): string {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
    return `${name} can't reach Claude: the API key was rejected. An admin needs to check ANTHROPIC_API_KEY.`
  if (error instanceof Anthropic.RateLimitError) return `Claude is getting too many requests right now. Ask again in a minute.`
  if (error.status === 402)
    return `Claude turned this request down for billing: the Anthropic account may have hit its spend limit. An admin needs to check the Anthropic Console.`
  if (error instanceof Anthropic.InternalServerError) return `Claude is having trouble right now (server error ${error.status}). Ask again in a few minutes.`
  if (error instanceof Anthropic.APIConnectionError) return `${name} couldn't reach Claude (network error). Ask again in a minute.`
  if (error instanceof Anthropic.APIUserAbortError) return `This answer was stopped before it finished.`
  return `Claude rejected the request${error.status ? ` (error ${error.status})` : ""}. That's a bug in ${name}; tell the tech team.`
}
