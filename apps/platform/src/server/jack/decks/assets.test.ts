import { describe, expect, it, vi } from "vitest"

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: { jackFile: { findMany } } }))

import { roomPhotoAssets } from "./assets"

describe("roomPhotoAssets", () => {
  it("lists the photos posted in this room, newest first, by their room URL", async () => {
    findMany.mockResolvedValueOnce([
      { id: "f1", filename: "pit crew.jpg", width: 1600, height: 1200, message: { author: { displayName: "Dylan" } } },
      { id: "f2", filename: "old.png", width: null, height: null, message: { author: null } },
    ])
    expect(await roomPhotoAssets("room-1")).toEqual([
      { url: "https://jack.assets/room/f1", about: '"pit crew.jpg", posted in this room by Dylan', width: 1600, height: 1200, group: "room" },
      { url: "https://jack.assets/room/f2", about: '"old.png", posted in this room by Former officer', width: 0, height: 0, group: "room" },
    ])
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { roomId: "room-1", kind: "IMAGE", status: "READY", messageId: { not: null } }, orderBy: { createdAt: "desc" }, take: 30 }))
  })
})
