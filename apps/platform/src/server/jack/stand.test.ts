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

  it("doesn't overwrite a title an officer set meanwhile, and posts no note", async () => {
    const room = db.addRoom({ title: "Officer's title" })
    const claude = fakeClaude([], [{ text: "Stand's Title" }])

    await nameRoom({ roomId: room.id, client: claude.client, broadcast, question: "Gray: Hi", answer: "Hello" })

    expect(db.room(room.id).title).toBe("Officer's title")
    expect(db.state.messages).toHaveLength(0)
    expect(events).toHaveLength(0)
  })

  it("gives up quietly on a refusal or an unusable name", async () => {
    const room = db.addRoom()
    const claude = fakeClaude([], [{ stop: "refusal" }, { text: "I'd call this room something like a discussion of entries and payments" }])

    await nameRoom({ roomId: room.id, client: claude.client, broadcast, question: "Gray: Hi", answer: "Hello" })
    await nameRoom({ roomId: room.id, client: claude.client, broadcast, question: "Gray: Hi", answer: "Hello" })

    expect(db.room(room.id).title).toBeNull()
    expect(events).toHaveLength(0)
  })

  it("sends Stand a short excerpt of a long exchange", async () => {
    const room = db.addRoom()
    const claude = fakeClaude([], [{ text: "Long Room" }])

    await nameRoom({ roomId: room.id, client: claude.client, broadcast, question: `Gray: ${"q".repeat(5_000)}`, answer: "a".repeat(5_000) })

    expect(JSON.stringify(claude.creates[0].messages).length).toBeLessThan(3_500)
    expect(db.room(room.id).title).toBe("Long Room")
  })
})
