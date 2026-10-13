import { beforeEach, describe, expect, it, vi } from "vitest"
import type { JackRoomEvent } from "@/lib/jack/types"
import type { FakeJackDb } from "./jack-test-db"

vi.mock("@/server/db", async () => {
  const { createFakeJackDb } = await import("./jack-test-db")
  return { prisma: createFakeJackDb() }
})

import { prisma } from "@/server/db"
import { fakeClaude } from "./fake-claude"
import { cleanTitle, nameRoom } from "./stand"

const db = prisma as unknown as FakeJackDb

describe("cleanTitle", () => {
  it.each([
    ["LSC Application Count", "LSC Application Count"],
    ['"LSC Application Count."', "LSC Application Count"],
    ["Title: GM 1 Planning", "GM 1 Planning"],
    ["**Paid Entries**\n\nThis room is about...", "Paid Entries"],
    ["  Expired   Checkouts  ", "Expired Checkouts"],
    ["“Members This Fall”", "Members This Fall"],
  ])("%j -> %j", (raw, title) => {
    expect(cleanTitle(raw)).toBe(title)
  })

  it("rejects what isn't a short name", () => {
    expect(cleanTitle("")).toBeNull()
    expect(cleanTitle("...")).toBeNull()
    expect(cleanTitle("This is a whole sentence about what the officers were asking Jack today")).toBeNull()
  })
})

describe("nameRoom", () => {
  const events: JackRoomEvent[] = []
  const broadcast = async (_roomId: string, event: JackRoomEvent) => {
    events.push(event)
  }

  beforeEach(() => {
    db.reset()
    events.length = 0
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("doesn't overwrite a title set meanwhile, and posts no note, but still counts what it cost", async () => {
    const room = db.addRoom({ title: "Officer's title" })
    const claude = fakeClaude([], [{ text: "Stand's Title", usage: { input: 200, output: 30 } }])

    await nameRoom({ roomId: room.id, client: claude.client, broadcast, question: "Gray: Hi", answer: "Hello" })

    expect(db.room(room.id).title).toBe("Officer's title")
    expect(db.state.messages).toHaveLength(0)
    expect(events).toHaveLength(0)
    expect(db.state.usage).toEqual([
      expect.objectContaining({ roomId: room.id, persona: "stand", job: "name_room", outcome: "already_titled", inputTokens: 200, outputTokens: 30 }),
    ])
    expect(db.state.usage[0].costUsd).toBeCloseTo((200 * 0.1 + 30 * 0.5) / 1e6, 9)
  })

  it("gives up quietly on a refusal or an unusable name, counting each call's cost", async () => {
    const room = db.addRoom()
    const claude = fakeClaude([], [{ stop: "refusal" }, { text: "I'd call this room something like a discussion of entries and payments" }])

    await nameRoom({ roomId: room.id, client: claude.client, broadcast, question: "Gray: Hi", answer: "Hello" })
    await nameRoom({ roomId: room.id, client: claude.client, broadcast, question: "Gray: Hi", answer: "Hello" })

    expect(db.room(room.id).title).toBeNull()
    expect(events).toHaveLength(0)
    expect(db.state.messages).toHaveLength(0)
    expect(db.state.usage.map((u) => u.outcome)).toEqual(["declined", "unusable"])
    expect(db.state.usage.every((u) => u.costUsd > 0 && u.model === "claude-haiku-5-5")).toBe(true)
  })

  it("records nothing when the call itself fails (there's no usage to count)", async () => {
    const room = db.addRoom()
    const claude = fakeClaude([], [{ error: new Error("overloaded") }])

    await nameRoom({ roomId: room.id, client: claude.client, broadcast, question: "Gray: Hi", answer: "Hello" })

    expect(db.state.usage).toHaveLength(0)
    expect(console.error).toHaveBeenCalled()
  })

  it("sends Stand a short excerpt of a long exchange", async () => {
    const room = db.addRoom()
    const claude = fakeClaude([], [{ text: "Long Room" }])

    await nameRoom({ roomId: room.id, client: claude.client, broadcast, question: `Gray: ${"q".repeat(5_000)}`, answer: "a".repeat(5_000) })

    expect(JSON.stringify(claude.creates[0].messages).length).toBeLessThan(3_500)
    expect(db.room(room.id).title).toBe("Long Room")
  })
})
