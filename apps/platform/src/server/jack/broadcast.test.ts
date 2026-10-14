import { describe, expect, it } from "vitest"
import type { JackToolPart } from "@/lib/jack/parts"
import type { JackDoneEvent, JackMessageView } from "@/lib/jack/types"
import { fitForBroadcast, MAX_BROADCAST_BYTES } from "./broadcast"

const part = (id: string, rows: number): JackToolPart => ({
  id,
  name: "run_sql",
  label: "Ran a query",
  status: "done",
  at: 0,
  input: { sql: "select 1" },
  displays: [{ kind: "table", columns: ["a", "b"], rows: Array.from({ length: rows }, (_, i) => [`row ${i} `.repeat(20), i]), truncated: false }],
})

const reply = (fields: Partial<JackMessageView> = {}): JackMessageView => ({
  id: "reply-1",
  roomId: "room-1",
  author: { kind: "assistant", persona: "jack" },
  content: "Here's what I found.",
  tools: [],
  status: "done",
  streamSeq: 4,
  answered: true,
  createdAt: "2026-10-13T20:00:00.000Z",
  ...fields,
})

const size = (event: unknown) => Buffer.byteLength(JSON.stringify(event), "utf8")

describe("fitForBroadcast", () => {
  it("sends a done event under the limit as it is", () => {
    const event: JackDoneEvent = { type: "message.done", message: reply({ tools: [part("t1", 5)] }) }
    expect(fitForBroadcast(event)).toBe(event)
  })

  it("leaves out the tool displays of a done event that's too big, and flags it", () => {
    const event: JackDoneEvent = { type: "message.done", message: reply({ tools: Array.from({ length: 12 }, (_, i) => part(`t${i}`, 120)) }) }
    expect(size(event)).toBeGreaterThan(MAX_BROADCAST_BYTES)

    const fitted = fitForBroadcast(event) as JackDoneEvent
    expect(fitted.trimmed).toBe(true)
    expect(size(fitted)).toBeLessThanOrEqual(MAX_BROADCAST_BYTES)
    expect(fitted.message.content).toBe("Here's what I found.")
    expect(fitted.message.tools.map((p) => [p.id, p.label, p.status, p.displays.length])).toEqual(event.message.tools.map((p) => [p.id, p.label, p.status, 0]))
  })

  it("leaves out the text too when even that is too big", () => {
    const event: JackDoneEvent = { type: "message.done", message: reply({ content: "x".repeat(MAX_BROADCAST_BYTES + 10) }) }
    const fitted = fitForBroadcast(event) as JackDoneEvent
    expect(fitted).toMatchObject({ trimmed: true, message: { id: "reply-1", status: "done", content: "", tools: [] } })
    expect(size(fitted)).toBeLessThanOrEqual(MAX_BROADCAST_BYTES)
  })

  it("never touches other events", () => {
    const delta = { type: "message.delta" as const, messageId: "reply-1", seq: 1, text: "y".repeat(MAX_BROADCAST_BYTES + 10) }
    expect(fitForBroadcast(delta)).toBe(delta)
  })
})
