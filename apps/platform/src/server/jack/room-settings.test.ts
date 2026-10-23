import { beforeEach, describe, expect, it, vi } from "vitest"
import type { JackRoomEvent } from "@/lib/jack/types"
import type { FakeJackDb } from "./jack-test-db"

vi.mock("@/server/db", async () => {
  const { createFakeJackDb } = await import("./jack-test-db")
  return { prisma: createFakeJackDb() }
})
vi.mock("./broadcast", () => ({ broadcastRoomEvent: vi.fn() }))

import { prisma } from "@/server/db"
import { answerModeLabel, ROOM_ARCHIVED, ROOM_GONE, setRoomAnswerMode, setRoomArchived, setRoomPinned, unavailableMessage } from "./room-settings"

const db = prisma as unknown as FakeJackDb
const gray = { id: "officer-gray", displayName: "Gray" }
const dylan = { id: "officer-dylan", displayName: "Dylan" }

let room: ReturnType<FakeJackDb["addRoom"]>
let sent: JackRoomEvent[]
const broadcast = async (_roomId: string, event: JackRoomEvent) => void sent.push(event)
const notes = () => db.state.messages.filter((m) => m.kind === "system")

beforeEach(() => {
  db.reset()
  room = db.addRoom({ title: "GM 2 planning" })
  sent = []
})

describe("setRoomArchived", () => {
  it("archives a room, posts who did it, and tells the room the new settings, then the note", async () => {
    const result = await setRoomArchived(room.id, gray, true, broadcast)

    expect(db.room(room.id).archivedAt).toBeInstanceOf(Date)
    expect(result).toMatchObject({ changed: true, room: { id: room.id, archivedAt: expect.any(String) }, message: { content: "Gray archived this room", author: { kind: "system" } } })
    expect(notes().map((n) => [n.content, n.authorUserId])).toEqual([["Gray archived this room", "officer-gray"]])
    expect(sent.map((e) => e.type)).toEqual(["room.updated", "message.created"])
  })

  it("brings it back, keeping its pin", async () => {
    const pinnedAt = new Date("2026-10-01T00:00:00Z")
    db.room(room.id).pinnedAt = pinnedAt
    await setRoomArchived(room.id, gray, true, broadcast)
    const result = await setRoomArchived(room.id, dylan, false, broadcast)

    expect(db.room(room.id).archivedAt).toBeNull()
    expect(db.room(room.id).pinnedAt).toBe(pinnedAt)
    expect(result).toMatchObject({ changed: true, room: { archivedAt: null, pinnedAt: pinnedAt.toISOString() }, message: { content: "Dylan unarchived this room" } })
  })

  it("changes nothing, and posts nothing, when it's already that way (two officers clicking at once post one note)", async () => {
    const results = await Promise.all([setRoomArchived(room.id, gray, true, broadcast), setRoomArchived(room.id, dylan, true, broadcast)])
    expect(results.filter((r) => r?.changed)).toHaveLength(1)
    expect(notes()).toHaveLength(1)
    expect(await setRoomArchived(room.id, gray, true, broadcast)).toMatchObject({ changed: false })
    expect(notes()).toHaveLength(1)
  })

  it("is null for a room that doesn't exist", async () => {
    expect(await setRoomArchived("room-missing", gray, true, broadcast)).toBeNull()
  })
})

describe("setRoomPinned", () => {
  it("pins and unpins without a note, telling the room", async () => {
    const pinned = await setRoomPinned(room.id, true, broadcast)
    expect(pinned).toMatchObject({ changed: true, room: { pinnedAt: expect.any(String) }, message: null })
    expect(db.room(room.id).pinnedAt).toBeInstanceOf(Date)
    expect(await setRoomPinned(room.id, true, broadcast)).toMatchObject({ changed: false })

    expect(await setRoomPinned(room.id, false, broadcast)).toMatchObject({ changed: true, room: { pinnedAt: null } })
    expect(notes()).toHaveLength(0)
    expect(sent.map((e) => e.type)).toEqual(["room.updated", "room.updated"])
  })

  it("is null for an archived room or one that doesn't exist", async () => {
    db.room(room.id).archivedAt = new Date()
    expect(await setRoomPinned(room.id, true, broadcast)).toBeNull()
    expect(db.room(room.id).pinnedAt).toBeNull()
    expect(await setRoomPinned("room-missing", true, broadcast)).toBeNull()
  })
})

describe("setRoomAnswerMode", () => {
  it("switches to mentions only, naming what to mention, and back", async () => {
    expect(await setRoomAnswerMode(room.id, gray, "mention", broadcast)).toMatchObject({
      changed: true,
      room: { answerMode: "mention" },
      message: { content: "Gray set this room to answer only messages that mention @Jack" },
    })
    expect(await setRoomAnswerMode(room.id, gray, "mention", broadcast)).toMatchObject({ changed: false })
    expect(await setRoomAnswerMode(room.id, dylan, "always", broadcast)).toMatchObject({ message: { content: "Dylan set this room to answer every message" } })
    expect(db.room(room.id).answerMode).toBe("always")
    expect(notes()).toHaveLength(2)
  })

  it("names the persona answering the room too", async () => {
    db.room(room.id).persona = "lift"
    const result = await setRoomAnswerMode(room.id, gray, "mention", broadcast)
    expect(result).toMatchObject({ message: { content: "Gray set this room to answer only messages that mention @Lift or @Jack" } })
    expect(answerModeLabel("mention", "stand")).toBe("answer only messages that mention @Stand or @Jack")
  })

  it("is null for an archived room", async () => {
    db.room(room.id).archivedAt = new Date()
    expect(await setRoomAnswerMode(room.id, gray, "mention", broadcast)).toBeNull()
    expect(db.room(room.id).answerMode).toBe("always")
  })
})

describe("unavailableMessage", () => {
  it("says whether a room is archived or gone", async () => {
    expect(await unavailableMessage(room.id)).toBe(ROOM_GONE)
    db.room(room.id).archivedAt = new Date()
    expect(await unavailableMessage(room.id)).toBe(ROOM_ARCHIVED)
    expect(await unavailableMessage("room-missing")).toBe(ROOM_GONE)
  })
})
