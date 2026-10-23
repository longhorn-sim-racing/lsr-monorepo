import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  jackRoom: { findUnique: vi.fn(), findMany: vi.fn() },
  jackMessage: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
}))
const feedback = vi.hoisted(() => ({ roomFeedback: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
// rooms.ts pulls in the reply loop; none of it runs here
vi.mock("./reply-loop", () => ({ defaultReplyDeps: {}, runRoom: vi.fn() }))
vi.mock("./broadcast", () => ({ broadcastRoomEvent: vi.fn() }))
vi.mock("@/server/after-response", () => ({ runAfterResponse: vi.fn() }))
vi.mock("./proposals/service", () => ({ roomProposalStates: vi.fn(async () => ({})) }))
vi.mock("./feedback", () => feedback)

import { roomSearchQuery, searchRooms } from "./room-search"
import { ANCHOR_BEFORE, getRoomSnapshot, SNAPSHOT_LIMIT } from "./rooms"

const room = { id: "room-1", title: "GM 2", persona: "jack", updatedAt: new Date("2026-10-20T00:00:00Z"), pinnedAt: null, answerMode: "always", archivedAt: null }
const message = (id: string) => ({
  id,
  roomId: "room-1",
  kind: "user",
  authorUserId: "u1",
  persona: null,
  content: id,
  toolCalls: null,
  status: "done",
  streamSeq: 0,
  answeredById: null,
  continues: false,
  createdAt: new Date("2026-10-19T23:00:00Z"),
  author: { displayName: "Gray", avatarUrl: null },
})

beforeEach(() => {
  db.jackRoom.findUnique.mockResolvedValue(room)
  db.jackMessage.findMany.mockResolvedValue([])
})

describe("getRoomSnapshot with an anchor (?m=)", () => {
  it("loads the latest messages when there's no anchor, or it isn't in this room", async () => {
    await getRoomSnapshot("room-1")
    expect(db.jackMessage.findFirst).not.toHaveBeenCalled()
    expect(db.jackMessage.findMany).toHaveBeenCalledTimes(1)
    expect(db.jackMessage.findMany.mock.calls[0][0]).toMatchObject({ where: { roomId: "room-1" }, take: 500 })

    db.jackMessage.findFirst.mockResolvedValue(null)
    await getRoomSnapshot("room-1", { around: "elsewhere" })
    expect(db.jackMessage.findFirst).toHaveBeenCalledWith({ where: { id: "elsewhere", roomId: "room-1" }, select: { id: true, createdAt: true } })
    expect(db.jackMessage.count).not.toHaveBeenCalled()
    expect(db.jackMessage.findMany.mock.calls[1][0]).toMatchObject({ take: 500 })
  })

  it("loads the latest messages when they already hold the anchor with enough before it", async () => {
    db.jackMessage.findFirst.mockResolvedValue({ id: "m400", createdAt: new Date("2026-10-01T00:00:00Z") })
    db.jackMessage.count.mockResolvedValue(500 - ANCHOR_BEFORE - 1)
    await getRoomSnapshot("room-1", { around: "m400" })
    expect(db.jackMessage.findMany).toHaveBeenCalledTimes(1)
    expect(db.jackMessage.findMany.mock.calls[0][0]).toMatchObject({ take: 500 })
  })

  it("loads a window the size of a normal snapshot from a little before an older anchor, and the gap it leaves before the newest", async () => {
    const anchorAt = new Date("2026-09-01T00:00:00Z")
    const newestAt = new Date("2026-10-20T00:00:00Z")
    db.jackMessage.findFirst.mockResolvedValueOnce({ id: "m50", createdAt: anchorAt }).mockResolvedValueOnce({ id: "m951", createdAt: newestAt })
    // 900 messages after the anchor: the window holds the anchor and 459 of them
    db.jackMessage.count.mockResolvedValue(900)
    const fromAnchor = Array.from({ length: SNAPSHOT_LIMIT - ANCHOR_BEFORE }, (_, i) => message(`m${50 + i}`))
    db.jackMessage.findMany.mockResolvedValueOnce([message("m49"), message("m48")]).mockResolvedValueOnce(fromAnchor)
    const snapshot = await getRoomSnapshot("room-1", { around: "m50" })
    const [before, from] = db.jackMessage.findMany.mock.calls.map((call) => call[0])
    expect(before).toMatchObject({
      where: { roomId: "room-1", OR: [{ createdAt: { lt: anchorAt } }, { createdAt: anchorAt, id: { lt: "m50" } }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ANCHOR_BEFORE,
    })
    expect(from).toMatchObject({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: SNAPSHOT_LIMIT - ANCHOR_BEFORE })
    expect(from.where.OR[0]).toEqual({ id: "m50" })
    expect(db.jackMessage.findFirst.mock.calls[1][0]).toMatchObject({ where: { roomId: "room-1" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })
    expect(snapshot!.messages.map((m) => m.id).slice(0, 4)).toEqual(["m48", "m49", "m50", "m51"])
    expect(snapshot!.messages.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT)
    expect(snapshot!.gap).toEqual({
      after: { id: "m509", createdAt: "2026-10-19T23:00:00.000Z" },
      through: { id: "m951", createdAt: "2026-10-20T00:00:00.000Z" },
      count: 900 - (SNAPSHOT_LIMIT - ANCHOR_BEFORE - 1),
    })
  })

  it("leaves no gap when the window turns out to reach the newest message (some were deleted meanwhile)", async () => {
    const anchorAt = new Date("2026-09-01T00:00:00Z")
    db.jackMessage.findFirst.mockResolvedValueOnce({ id: "m50", createdAt: anchorAt }).mockResolvedValueOnce({ id: "m51", createdAt: anchorAt })
    db.jackMessage.count.mockResolvedValue(SNAPSHOT_LIMIT)
    db.jackMessage.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([message("m50"), message("m51")])
    expect((await getRoomSnapshot("room-1", { around: "m50" }))!.gap).toBeUndefined()
  })

  it("finds nothing for a missing room", async () => {
    db.jackRoom.findUnique.mockResolvedValue(null)
    expect(await getRoomSnapshot("gone", { around: "m1" })).toBeNull()
  })

  it("opens an archived room too (its page is read-only), with the room's settings", async () => {
    const archivedAt = new Date("2026-10-21T15:00:00Z")
    db.jackRoom.findUnique.mockResolvedValue({ ...room, archivedAt, pinnedAt: archivedAt, answerMode: "mention" })
    const snapshot = await getRoomSnapshot("room-1")
    expect(db.jackRoom.findUnique.mock.calls[0][0].where).toEqual({ id: "room-1" })
    expect(snapshot!.room).toEqual({
      id: "room-1",
      title: "GM 2",
      persona: "jack",
      updatedAt: "2026-10-20T00:00:00.000Z",
      archivedAt: "2026-10-21T15:00:00.000Z",
      pinnedAt: "2026-10-21T15:00:00.000Z",
      answerMode: "mention",
    })
  })

  it("holds the replies' ratings as the viewing officer sees them, only when asked for a viewer", async () => {
    const ratings = { r1: { up: 1, down: 0, mine: { rating: "up", note: null }, raters: [] } }
    feedback.roomFeedback.mockResolvedValue(ratings)
    expect((await getRoomSnapshot("room-1"))!.feedback).toBeUndefined()
    expect(feedback.roomFeedback).not.toHaveBeenCalled()
    expect((await getRoomSnapshot("room-1", { viewerId: "u1" }))!.feedback).toEqual(ratings)
    expect(feedback.roomFeedback).toHaveBeenCalledWith("room-1", "u1")
  })
})

describe("the rooms list search", () => {
  it("reads the query from the URL, trimmed and capped", () => {
    expect(roomSearchQuery(undefined)).toBeNull()
    expect(roomSearchQuery("   ")).toBeNull()
    expect(roomSearchQuery(["  budget ", "other"])).toBe("budget")
    expect(roomSearchQuery("x".repeat(300))).toHaveLength(200)
  })

  it("finds rooms by name and every kind of message, archived rooms included and marked, linking each message in place", async () => {
    const archivedAt = new Date("2026-10-21T15:00:00Z")
    db.jackRoom.findMany
      .mockResolvedValueOnce([
        { id: "room-1", title: "Budget planning", persona: "jack", createdAt: new Date(), updatedAt: new Date(), pinnedAt: null, archivedAt: null, createdBy: null },
        { id: "room-2", title: "Old budget", persona: "jack", createdAt: new Date(), updatedAt: new Date(), pinnedAt: null, archivedAt, createdBy: null },
      ])
      .mockResolvedValueOnce([{ id: "room-2" }])
    db.$queryRaw.mockResolvedValue([
      { id: "m1", roomId: "room-1", kind: "assistant", persona: "jack", createdAt: new Date("2026-10-19T23:00:00Z"), roomTitle: "Budget planning", author: null, rank: 0.5, snippet: "the budget" },
      { id: "m2", roomId: "room-2", kind: "user", persona: null, createdAt: new Date("2026-10-18T23:00:00Z"), roomTitle: "Old budget", author: "Gray", rank: 0.4, snippet: "budget again" },
    ])
    const result = await searchRooms("budget")
    const [byName, archived] = db.jackRoom.findMany.mock.calls.map((call) => call[0])
    expect(byName.where).toEqual({ title: { contains: "budget", mode: "insensitive" }, NOT: { id: { startsWith: "jack-eval-" } } })
    // Rooms in use first
    expect(byName.orderBy[0]).toEqual({ archivedAt: { sort: "desc", nulls: "first" } })
    expect(archived.where).toEqual({ id: { in: ["room-1", "room-2"] }, archivedAt: { not: null } })
    const sql = db.$queryRaw.mock.calls[0][0] as Prisma.Sql
    expect(sql.values).toEqual(expect.arrayContaining(["user", "system", "assistant"]))
    expect(sql.sql).not.toContain(`r."archivedAt" IS NULL`)
    expect(result.rooms.map((r) => [r.title, r.archivedAt])).toEqual([
      ["Budget planning", null],
      ["Old budget", "2026-10-21T15:00:00.000Z"],
    ])
    expect(result.messages).toEqual([
      { id: "m1", roomId: "room-1", roomTitle: "Budget planning", kind: "assistant", author: "Jack", createdAt: "2026-10-19T23:00:00.000Z", snippet: "the budget", href: "/admin/jack/room-1?m=m1", roomArchived: false },
      { id: "m2", roomId: "room-2", roomTitle: "Old budget", kind: "user", author: "Gray", createdAt: "2026-10-18T23:00:00.000Z", snippet: "budget again", href: "/admin/jack/room-2?m=m2", roomArchived: true },
    ])
  })

  it("asks nothing more when no message matched", async () => {
    db.jackRoom.findMany.mockResolvedValueOnce([])
    db.$queryRaw.mockResolvedValue([])
    expect(await searchRooms("nothing")).toEqual({ query: "nothing", rooms: [], messages: [] })
    expect(db.jackRoom.findMany).toHaveBeenCalledTimes(1)
  })
})
