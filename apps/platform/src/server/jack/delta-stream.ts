import { JACK_EVENT } from "@/lib/jack/types"
import type { RoomBroadcaster } from "./broadcast"

/** How often a streaming reply goes out: about 7 broadcasts a second, well under Realtime's free-tier limits */
export const DELTA_FLUSH_MS = 150
/** How often the partial reply is saved, for viewers who open the room mid-answer */
export const DELTA_PERSIST_MS = 1_000

export type DeltaStreamOptions = {
  roomId: string
  messageId: string
  broadcast: RoomBroadcaster
  /** Saves the text so far and the seq of the last delta it includes */
  persist: (content: string, streamSeq: number) => Promise<void>
  flushMs?: number
  persistMs?: number
  now?: () => number
}

/**
 * Batches a reply's text into numbered deltas: whatever was written in the last ~150 ms goes out as
 * one broadcast with the next seq (1, 2, 3, ...), and about once a second the text so far is saved
 * with its seq. Broadcasts and saves run one at a time, in order.
 *
 * A failed save is logged and the stream goes on: it's only there for viewers who open the room
 * mid-answer, and the reply's final save writes the whole text anyway.
 */
export class DeltaStream {
  private readonly flushMs: number
  private readonly persistMs: number
  private readonly now: () => number
  private buffer = ""
  private content = ""
  private seq = 0
  private persistedSeq = 0
  private lastPersist: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private failure: unknown = null
  private aborted = false
  /** Set by reset(): the next delta replaces the text with this (plus whatever was written after it) */
  private resetTo: string | null = null

  constructor(private readonly options: DeltaStreamOptions) {
    this.flushMs = options.flushMs ?? DELTA_FLUSH_MS
    this.persistMs = options.persistMs ?? DELTA_PERSIST_MS
    this.now = options.now ?? Date.now
    this.lastPersist = this.now()
  }

  write(text: string): void {
    if (!text) return
    this.buffer += text
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.enqueue(() => this.flush())
    }, this.flushMs)
  }

  /**
   * Takes back text that already streamed: the reply's text is now `content` (what it was before the
   * part being dropped, e.g. a declined partial or a call that came through garbled). The next delta
   * carries the whole text with `replace: true`, so viewers swap it in rather than append, in seq order
   * with everything else. Text written after this follows it.
   */
  reset(content: string): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.buffer = ""
    this.resetTo = content
    this.enqueue(() => this.flush())
  }

  /**
   * Sends the text written so far, then runs `step` in line with the deltas: a tool part broadcast
   * this way reaches viewers after the text that came before it. `step` should handle its own errors;
   * one that throws fails the stream like a failed save.
   */
  sendInOrder(step: () => Promise<void>): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.enqueue(() => this.flush())
    this.enqueue(step)
    return this.queue
  }

  /** Sends what's left. Returns the whole text with the last seq; the caller saves it with the final status */
  async end(): Promise<{ content: string; streamSeq: number }> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.enqueue(() => this.flush())
    await this.queue
    if (this.failure) throw this.failure
    return { content: this.content, streamSeq: this.seq }
  }

  /** Stops sending and returns what went out so far (or what a pending reset() left), for a reply that failed */
  abort(): { content: string; streamSeq: number } {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.aborted = true
    return { content: this.resetTo ?? this.content, streamSeq: this.seq }
  }

  private enqueue(step: () => Promise<void>) {
    this.queue = this.queue.then(async () => {
      if (this.failure || this.aborted) return
      try {
        await step()
      } catch (error) {
        this.failure = error
      }
    })
  }

  private async flush() {
    const replace = this.resetTo !== null
    if (!replace && !this.buffer) return
    const text = replace ? this.resetTo + this.buffer : this.buffer
    this.resetTo = null
    this.buffer = ""
    this.content = replace ? text : this.content + text
    this.seq++
    await this.options.broadcast(this.options.roomId, {
      type: JACK_EVENT.delta,
      messageId: this.options.messageId,
      seq: this.seq,
      text,
      ...(replace ? { replace: true as const } : {}),
    })
    if (this.now() - this.lastPersist >= this.persistMs && this.persistedSeq < this.seq) {
      this.lastPersist = this.now()
      this.persistedSeq = this.seq
      try {
        await this.options.persist(this.content, this.seq)
      } catch (error) {
        console.error(`[jack] Couldn't save the partial reply ${this.options.messageId} (seq ${this.seq}); it keeps streaming:`, error)
      }
    }
  }
}
