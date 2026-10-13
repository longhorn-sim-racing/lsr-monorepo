import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { JackRoomEvent } from "@/lib/jack/types"
import { DeltaStream } from "./delta-stream"

let sent: JackRoomEvent[]
let saves: { content: string; streamSeq: number }[]

function stream() {
  return new DeltaStream({
    roomId: "room-1",
    messageId: "reply-1",
    broadcast: async (_roomId, event) => {
      sent.push(event)
    },
    persist: async (content, streamSeq) => {
      saves.push({ content, streamSeq })
    },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  saves = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe("DeltaStream", () => {
  it("joins everything written within 150 ms into one numbered delta", async () => {
    const s = stream()
    s.write("Jack ")
    s.write("here")
    await vi.advanceTimersByTimeAsync(149)
    expect(sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    s.write(".")
    const result = await s.end()

    expect(sent).toEqual([
      { type: "message.delta", messageId: "reply-1", seq: 1, text: "Jack here" },
      { type: "message.delta", messageId: "reply-1", seq: 2, text: "." },
    ])
    expect(result).toEqual({ content: "Jack here.", streamSeq: 2 })
  })

  it("saves the text so far about once a second, matched to its seq", async () => {
    const s = stream()
    for (let i = 0; i < 20; i++) {
      s.write(`${i} `)
      await vi.advanceTimersByTimeAsync(150)
    }
    await s.end()

    expect(sent).toHaveLength(20)
    expect(saves.length).toBeGreaterThanOrEqual(2)
    expect(saves.length).toBeLessThanOrEqual(3)
    for (const save of saves) {
      const through = sent.slice(0, save.streamSeq).map((e) => (e.type === "message.delta" ? e.text : ""))
      expect(save.content).toBe(through.join(""))
    }
  })

  it("sends nothing more once aborted", async () => {
    const s = stream()
    s.write("partial")
    await vi.advanceTimersByTimeAsync(150)
    s.write(" never sent")
    expect(s.abort()).toEqual({ content: "partial", streamSeq: 1 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveLength(1)
  })
})
