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
  signal?: AbortSignal
}

export type JackToolResult = {
  /** What the model reads back: compact JSON or text. Keep it small; rows are capped by the tool. */
  forModel: string
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
  run: (input: I, ctx: JackToolContext) => Promise<JackToolResult>
}

/** Lets a list hold tools with different input types */
export type AnyJackTool = JackTool<any> // eslint-disable-line @typescript-eslint/no-explicit-any
