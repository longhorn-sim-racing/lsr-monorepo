import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { JackRoomEvent } from "@/lib/jack/types"
import { DeltaStream } from "./delta-stream"

let sent: JackRoomEvent[]
let saves: { content: string; streamSeq: number }[]

function stream(persist?: (content: string, streamSeq: number) => Promise<void>) {
  return new DeltaStream({
    roomId: "room-1",
    messageId: "reply-1",
    broadcast: async (_roomId, event) => {
      sent.push(event)
    },
    persist:
      persist ??
      (async (content, streamSeq) => {
        saves.push({ content, streamSeq })
      }),
  })
}

/** What a viewer ends up with, applying each delta in seq order (appending, or swapping in on replace) */
function viewerText(events: JackRoomEvent[]) {
  let text = ""
  for (const event of events) if (event.type === "message.delta") text = event.replace ? event.text : text + event.text
  return text
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

  it("keeps streaming when a partial save fails, and still ends with the whole text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    let attempts = 0
    const s = stream(async () => {
      attempts++
      throw new Error("connection reset")
    })
    for (let i = 0; i < 15; i++) {
      s.write(`${i} `)
      await vi.advanceTimersByTimeAsync(150)
    }
    const result = await s.end()

    expect(attempts).toBeGreaterThanOrEqual(2) // it kept trying on schedule
    expect(sent).toHaveLength(15) // every delta still went out
    expect(result.content).toBe(Array.from({ length: 15 }, (_, i) => `${i} `).join(""))
    expect(result.streamSeq).toBe(15)
    expect(error).toHaveBeenCalled()
  })

  it("takes back streamed text with a replacing delta, in order with what comes after", async () => {
    const s = stream()
    s.write("Sure, here is how")
    await vi.advanceTimersByTimeAsync(150)
    s.write(" to") // not sent yet: dropped with the rest
    s.reset("")
    s.write("I can't help with that one.")
    const result = await s.end()

    expect(sent).toEqual([
      { type: "message.delta", messageId: "reply-1", seq: 1, text: "Sure, here is how" },
      { type: "message.delta", messageId: "reply-1", seq: 2, text: "I can't help with that one.", replace: true },
    ])
    expect(viewerText(sent)).toBe("I can't help with that one.")
    expect(result).toEqual({ content: "I can't help with that one.", streamSeq: 2 })
  })

  it("keeps the text before the part it takes back", async () => {
    const s = stream()
    s.write("Let me check. ")
    await vi.advanceTimersByTimeAsync(150)
    s.write("Counting the")
    await vi.advanceTimersByTimeAsync(150)
    s.reset("Let me check. ")
    await vi.advanceTimersByTimeAsync(0)
    s.write("Counting.")
    const result = await s.end()

    expect(sent.map((e) => (e.type === "message.delta" ? [e.seq, e.text, e.replace ?? false] : null))).toEqual([
      [1, "Let me check. ", false],
      [2, "Counting the", false],
      [3, "Let me check. ", true],
      [4, "Counting.", false],
    ])
    expect(viewerText(sent)).toBe("Let me check. Counting.")
    expect(result.content).toBe("Let me check. Counting.")
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
