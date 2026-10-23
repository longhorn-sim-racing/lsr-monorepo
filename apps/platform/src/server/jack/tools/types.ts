import type { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"

/** Who a tool call runs for, and where */
export type JackToolContext = {
  roomId: string
  /**
   * The officer whose message started this reply: the newest message it answers. When one reply
   * answers several officers, tools run (and draft_event credits) only this one
   */
  actor: { userId: string | null; displayName: string }
  /** The reply this call is part of (deck changes record it). Absent outside a room reply, e.g. scripts */
  messageId?: string
  signal?: AbortSignal
}

/** An image a tool shows the model (base64), after a line of text that says what it is */
export type JackModelImage = { caption: string; mediaType: "image/jpeg" | "image/png"; data: string }

export type JackToolResult = {
  /** What the model reads back: compact JSON or text. Keep it small; rows are capped by the tool. */
  forModel: string
  /** Images the model looks at after the text (deck renders), each with its caption. Not saved or shown in the room */
  images?: JackModelImage[]
  /** A short human summary for the room, e.g. "Ran a query (13 rows)" */
  label: string
  /** What the room shows for this call */
  displays?: JackToolDisplay[]
  /** The model sees an error result (it can fix its input and try again); the room shows the label as an error */
  isError?: boolean
}

/**
 * A tool Jack can call. Every tool runs on the server, as the officer who asked, and only reads,
 * except the few marked `writes`, which only create drafts a person must publish.
 */
export type JackTool<I = unknown> = {
  /** snake_case, stable: saved in old messages */
  name: string
  /** What the tool does and when to use it, written for the model */
  description: string
  /** Validated before `run`; also sent to the model as JSON Schema (z.toJSONSchema) */
  input: z.ZodType<I>
  writes?: boolean
  /** A deck tool (#177): a reply that calls one gets the design limits (more tool calls and output; REPLY_LIMITS) */
  design?: boolean
  /** How long one call may run, when it needs longer than REPLY_LIMITS.toolTimeoutMs (rendering many slides) */
  timeoutMs?: number
  /** Loaded through tool search instead of up front, for rarely used tools (design §7.1); wired in G8, ignored until then */
  deferred?: boolean
  run: (input: I, ctx: JackToolContext) => Promise<JackToolResult>
}

/** Lets a list hold tools with different input types */
export type AnyJackTool = JackTool<any> // eslint-disable-line @typescript-eslint/no-explicit-any
