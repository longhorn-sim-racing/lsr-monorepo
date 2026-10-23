import type { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"

/**
 * What a reply is for (design §7.2): an officer's message in a room, or a scheduled run (recurring
 * questions, digest summaries). Scheduled runs never get the web tools
 */
export type JackRequestType = "room" | "scheduled"

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
  /** Set by the model loop; absent outside it (scripts). Tools that must not act in scheduled runs check it */
  requestType?: JackRequestType
  signal?: AbortSignal
}

/** An image a tool shows the model (base64), after a line of text that says what it is */
export type JackModelImage = { caption: string; mediaType: "image/jpeg" | "image/png"; data: string }

/**
 * A document a tool shows the model (a PDF, read with its pages as images), after a line of text that
 * says what it is: by Claude Files API id (uploaded on the server; never an id from the browser), or
 * as base64 when it isn't uploaded. The id must be a PDF's: an image's file id here is a 400
 */
export type JackModelDocument = {
  caption: string
  /** Shown to the model as the document's title */
  title?: string
  source: { type: "file"; fileId: string } | { type: "base64"; mediaType: "application/pdf"; data: string }
}

export type JackToolResult = {
  /** What the model reads back: compact JSON or text. Keep it small; rows are capped by the tool. */
  forModel: string
  /** Images the model looks at after the text (deck renders), each with its caption. Not saved or shown in the room */
  images?: JackModelImage[]
  /** Documents the model reads after the text and before any images, each with its caption. Not saved or shown in the room */
  documents?: JackModelDocument[]
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
  /**
   * Loaded through tool search instead of up front, for rarely used tools (design §7.1): sent with
   * `defer_loading`, and the request gets the tool search tool. Name it with its service's prefix
   * (`stripe_`, `discord_`) and say what it covers in the description, since that's what search matches
   */
  deferred?: boolean
  /** Only offered with the web tools (JACK_WEB_TOOLS=on, and only in room replies), e.g. web_links */
  web?: boolean
  run: (input: I, ctx: JackToolContext) => Promise<JackToolResult>
}

/** Lets a list hold tools with different input types */
export type AnyJackTool = JackTool<any> // eslint-disable-line @typescript-eslint/no-explicit-any
