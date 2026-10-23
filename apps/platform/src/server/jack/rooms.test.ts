import { describe, expect, it, vi } from "vitest"

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn(async () => []) }))
vi.mock("@/server/db", () => ({ prisma: { jackRoom: { findMany } } }))

import { EVAL_ROOM_PREFIX } from "./eval-support"
import { listRooms } from "./rooms"

describe("listRooms", () => {
  it("leaves out archived rooms and the eval's rooms", async () => {
    await listRooms()
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { archivedAt: null, NOT: { id: { startsWith: EVAL_ROOM_PREFIX } } } }))
    expect(EVAL_ROOM_PREFIX).toBe("jack-eval-")
  })
})
