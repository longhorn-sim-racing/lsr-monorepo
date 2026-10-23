import { describe, expect, it, vi } from "vitest"

const { findMany, findFirst, count, userFindUnique, create } = vi.hoisted(() => ({
  findMany: vi.fn(async (): Promise<unknown[]> => []),
  findFirst: vi.fn(),
  count: vi.fn(async () => 0),
  userFindUnique: vi.fn(),
  create: vi.fn(),
}))
vi.mock("@/server/db", () => {
  const tx = {
    jackMessage: {
      create,
      findUniqueOrThrow: vi.fn(async () => ({
        id: "msg-1",
        roomId: "room-1",
        kind: "user",
        authorUserId: "user-1",
        authorLabel: create.mock.calls.at(-1)?.[0].data.authorLabel ?? null,
        content: "Hi",
        toolCalls: null,
        status: "done",
        streamSeq: 0,
        answeredById: null,
        continues: false,
        expectsAnswer: true,
        createdAt: new Date("2026-10-22T20:00:00Z"),
        author: { displayName: "Gray", avatarUrl: null },
        files: [],
      })),
    },
    jackRoom: { update: vi.fn() },
  }
  return { prisma: { jackRoom: { findMany, findFirst, count }, user: { findUnique: userFindUnique }, $transaction: (work: (t: typeof tx) => unknown) => work(tx) } }
})
// The run after the response isn't part of this
vi.mock("@/server/after-response", () => ({ runAfterResponse: vi.fn() }))

import { EVAL_ROOM_PREFIX } from "./eval-support"
import { countArchivedRooms, listRooms, postOfficerMessage } from "./rooms"

const at = (iso: string) => new Date(iso)
const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  title: id,
  persona: "jack",
  createdAt: at("2026-10-01T00:00:00Z"),
  updatedAt: at("2026-10-20T00:00:00Z"),
  pinnedAt: null,
  archivedAt: null,
  createdBy: { displayName: "Gray" },
  ...fields,
})

describe("listRooms", () => {
  it("leaves out archived rooms and the eval's rooms", async () => {
    await listRooms()
    for (const [args] of findMany.mock.calls as unknown as [{ where: Record<string, unknown> }][]) {
      expect(args.where).toMatchObject({ archivedAt: null, NOT: { id: { startsWith: EVAL_ROOM_PREFIX } } })
    }
    expect(EVAL_ROOM_PREFIX).toBe("jack-eval-")
  })

  it("puts pinned rooms first, then the rest, each newest activity first", async () => {
    findMany.mockResolvedValueOnce([row("pinned", { pinnedAt: at("2026-10-02T00:00:00Z") })]).mockResolvedValueOnce([row("newest"), row("older")])
    const rooms = await listRooms()
    const [pinned, others] = findMany.mock.calls.map((call) => (call as unknown as [{ where: Record<string, unknown>; orderBy: unknown }])[0])
    expect(pinned.where).toMatchObject({ pinnedAt: { not: null } })
    expect(others.where).toMatchObject({ pinnedAt: null })
    expect(pinned.orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }])
    expect(rooms.map((r) => [r.id, r.pinnedAt])).toEqual([
      ["pinned", "2026-10-02T00:00:00.000Z"],
      ["newest", null],
      ["older", null],
    ])
    expect(rooms[0]).toMatchObject({ createdByName: "Gray", archivedAt: null, updatedAt: "2026-10-20T00:00:00.000Z" })
  })

  it("lists only the archived rooms, most recently archived first, when asked", async () => {
    findMany.mockResolvedValueOnce([row("gone", { archivedAt: at("2026-10-21T00:00:00Z") })])
    const rooms = await listRooms({ archived: true })
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany.mock.calls[0]).toEqual([
      expect.objectContaining({ where: { archivedAt: { not: null }, NOT: { id: { startsWith: EVAL_ROOM_PREFIX } } }, orderBy: [{ archivedAt: "desc" }, { id: "asc" }] }),
    ])
    expect(rooms[0].archivedAt).toBe("2026-10-21T00:00:00.000Z")
  })

  it("counts archived rooms, not the eval's", async () => {
    count.mockResolvedValueOnce(3)
    expect(await countArchivedRooms()).toBe(3)
    expect(count).toHaveBeenCalledWith({ where: { archivedAt: { not: null }, NOT: { id: { startsWith: EVAL_ROOM_PREFIX } } } })
  })
})

describe("postOfficerMessage", () => {
  it("saves who's asking with the message, from the officer's profile as it is now", async () => {
    findFirst.mockResolvedValueOnce({ id: "room-1" })
    create.mockResolvedValueOnce({ id: "msg-1" })
    userFindUnique.mockResolvedValueOnce({ displayName: "Gray", handle: "gray-marshall", officerTitle: "Technology Director", department: "technology", major: "CS" })
    const message = await postOfficerMessage("room-1", "user-1", "Hi")
    expect(create).toHaveBeenCalledWith({
      data: { roomId: "room-1", kind: "user", authorUserId: "user-1", content: "Hi", expectsAnswer: true, authorLabel: "Gray (Technology Director · Technology · CS) [@gray-marshall]" },
    })
    expect(message?.author).toMatchObject({ kind: "user", displayName: "Gray", label: "Gray (Technology Director · Technology · CS) [@gray-marshall]" })
  })
})
