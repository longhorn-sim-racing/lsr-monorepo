import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  jackRoom: { findFirst: vi.fn(), findMany: vi.fn() },
  jackMessage: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))
// rooms.ts pulls in the reply loop; none of it runs here
vi.mock("./reply-loop", () => ({ defaultReplyDeps: {}, runRoom: vi.fn() }))
vi.mock("./broadcast", () => ({ broadcastRoomEvent: vi.fn() }))
vi.mock("@/server/after-response", () => ({ runAfterResponse: vi.fn() }))

import { roomSearchQuery, searchRooms } from "./room-search"
import { ANCHOR_BEFORE, getRoomSnapshot, SNAPSHOT_LIMIT } from "./rooms"

const room = { id: "room-1", title: "GM 2", persona: "jack", updatedAt: new Date("2026-10-20T00:00:00Z") }
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
  db.jackRoom.findFirst.mockResolvedValue(room)
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

  it("finds nothing for an archived or missing room", async () => {
    db.jackRoom.findFirst.mockResolvedValue(null)
    expect(await getRoomSnapshot("gone", { around: "m1" })).toBeNull()
  })
})

describe("the rooms list search", () => {
  it("reads the query from the URL, trimmed and capped", () => {
    expect(roomSearchQuery(undefined)).toBeNull()
    expect(roomSearchQuery("   ")).toBeNull()
    expect(roomSearchQuery(["  budget ", "other"])).toBe("budget")
    expect(roomSearchQuery("x".repeat(300))).toHaveLength(200)
  })

  it("finds rooms by name and every kind of message, leaving out archived rooms, linking each message in place", async () => {
    db.jackRoom.findMany.mockResolvedValue([{ id: "room-1", title: "Budget planning", persona: "jack", createdAt: new Date(), updatedAt: new Date(), createdBy: null }])
    db.$queryRaw.mockResolvedValue([{ id: "m1", roomId: "room-1", kind: "assistant", persona: "jack", createdAt: new Date("2026-10-19T23:00:00Z"), roomTitle: "Budget planning", author: null, rank: 0.5, snippet: "the budget" }])
    const result = await searchRooms("budget")
    expect(db.jackRoom.findMany.mock.calls[0][0].where).toEqual({ archivedAt: null, title: { contains: "budget", mode: "insensitive" } })
    const sql = db.$queryRaw.mock.calls[0][0] as Prisma.Sql
    expect(sql.values).toEqual(expect.arrayContaining(["user", "system", "assistant"]))
    expect(sql.sql).toContain(`r."archivedAt" IS NULL`)
    expect(result.rooms.map((r) => r.title)).toEqual(["Budget planning"])
    expect(result.messages).toEqual([
      { id: "m1", roomId: "room-1", roomTitle: "Budget planning", kind: "assistant", author: "Jack", createdAt: "2026-10-19T23:00:00.000Z", snippet: "the budget", href: "/admin/jack/room-1?m=m1" },
    ])
  })
})
