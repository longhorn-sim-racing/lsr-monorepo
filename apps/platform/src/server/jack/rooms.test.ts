import { describe, expect, it, vi } from "vitest"

const { findMany, findFirst, userFindUnique, create } = vi.hoisted(() => ({
  findMany: vi.fn(async () => []),
  findFirst: vi.fn(),
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
        createdAt: new Date("2026-10-22T20:00:00Z"),
        author: { displayName: "Gray", avatarUrl: null },
        files: [],
      })),
    },
    jackRoom: { update: vi.fn() },
  }
  return { prisma: { jackRoom: { findMany, findFirst }, user: { findUnique: userFindUnique }, $transaction: (work: (t: typeof tx) => unknown) => work(tx) } }
})
// The run after the response isn't part of this
vi.mock("@/server/after-response", () => ({ runAfterResponse: vi.fn() }))

import { EVAL_ROOM_PREFIX } from "./eval-support"
import { listRooms, postOfficerMessage } from "./rooms"

describe("listRooms", () => {
  it("leaves out archived rooms and the eval's rooms", async () => {
    await listRooms()
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { archivedAt: null, NOT: { id: { startsWith: EVAL_ROOM_PREFIX } } } }))
    expect(EVAL_ROOM_PREFIX).toBe("jack-eval-")
  })
})

describe("postOfficerMessage", () => {
  it("saves who's asking with the message, from the officer's profile as it is now", async () => {
    findFirst.mockResolvedValueOnce({ id: "room-1" })
    create.mockResolvedValueOnce({ id: "msg-1" })
    userFindUnique.mockResolvedValueOnce({ displayName: "Gray", handle: "gray-marshall", officerTitle: "Technology Director", department: "technology", major: "CS" })
    const message = await postOfficerMessage("room-1", "user-1", "Hi")
    expect(create).toHaveBeenCalledWith({
      data: { roomId: "room-1", kind: "user", authorUserId: "user-1", content: "Hi", authorLabel: "Gray (Technology Director · Technology · CS) [@gray-marshall]" },
    })
    expect(message?.author).toMatchObject({ kind: "user", displayName: "Gray", label: "Gray (Technology Director · Technology · CS) [@gray-marshall]" })
  })
})
