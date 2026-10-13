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

  /** Sends what's left. Returns the whole text with the last seq; the caller saves it with the final status */
  async end(): Promise<{ content: string; streamSeq: number }> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.enqueue(() => this.flush())
    await this.queue
    if (this.failure) throw this.failure
    return { content: this.content, streamSeq: this.seq }
  }

  /** Stops sending and returns what went out so far, for a reply that failed */
  abort(): { content: string; streamSeq: number } {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.aborted = true
    return { content: this.content, streamSeq: this.seq }
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
    if (!this.buffer) return
    const text = this.buffer
    this.buffer = ""
    this.content += text
    this.seq++
    await this.options.broadcast(this.options.roomId, {
      type: JACK_EVENT.delta,
      messageId: this.options.messageId,
      seq: this.seq,
      text,
    })
    if (this.now() - this.lastPersist >= this.persistMs && this.persistedSeq < this.seq) {
      this.lastPersist = this.now()
      this.persistedSeq = this.seq
      await this.options.persist(this.content, this.seq)
    }
  }
}
