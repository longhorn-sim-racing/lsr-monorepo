import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  jackMessage: { findUnique: vi.fn() },
  jackFeedback: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { roomFeedback, setReplyFeedback } from "./feedback"

const reply = (fields: Record<string, unknown> = {}) => ({ roomId: "room-1", kind: "assistant", status: "done", room: { archivedAt: null }, ...fields })

beforeEach(() => {
  db.jackMessage.findUnique.mockResolvedValue(reply())
  db.jackFeedback.findMany.mockResolvedValue([])
})

describe("setReplyFeedback", () => {
  it("saves a rating, one per officer per reply, replacing the note and dating it now", async () => {
    db.jackFeedback.findMany.mockResolvedValue([{ messageId: "r1", userId: "gray", rating: "down", note: "Wrong date", user: { displayName: "Gray" } }])
    const result = await setReplyFeedback({ messageId: "r1", userId: "gray", rating: "down", note: "Wrong date" })

    expect(db.jackFeedback.upsert).toHaveBeenCalledWith({
      where: { messageId_userId: { messageId: "r1", userId: "gray" } },
      create: { messageId: "r1", userId: "gray", rating: "down", note: "Wrong date" },
      update: { rating: "down", note: "Wrong date", createdAt: expect.any(Date) },
    })
    expect(result).toEqual({ ok: true, roomId: "room-1", summary: { up: 0, down: 1, mine: { rating: "down", note: "Wrong date" }, raters: [{ userId: "gray", name: "Gray", rating: "down", note: "Wrong date" }] } })
    expect(db.jackFeedback.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { messageId: "r1" } }))
  })

  it("takes a rating back", async () => {
    const result = await setReplyFeedback({ messageId: "r1", userId: "gray", rating: null, note: null })
    expect(db.jackFeedback.deleteMany).toHaveBeenCalledWith({ where: { messageId: "r1", userId: "gray" } })
    expect(db.jackFeedback.upsert).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, roomId: "room-1", summary: { up: 0, down: 0, mine: null, raters: [] } })
  })

  it("rates only Jack's finished replies, in rooms that aren't archived", async () => {
    const refused = async (message: unknown) => {
      db.jackMessage.findUnique.mockResolvedValueOnce(message)
      return setReplyFeedback({ messageId: "r1", userId: "gray", rating: "up", note: null })
    }
    expect(await refused(null)).toEqual({ ok: false, error: "That reply doesn't exist anymore." })
    expect(await refused(reply({ kind: "user" }))).toEqual({ ok: false, error: "That reply doesn't exist anymore." })
    expect(await refused(reply({ room: { archivedAt: new Date() } }))).toMatchObject({ ok: false, error: expect.stringContaining("archived") })
    expect(await refused(reply({ status: "streaming" }))).toEqual({ ok: false, error: "Wait for the reply to finish first." })
    expect(db.jackFeedback.upsert).not.toHaveBeenCalled()
    expect(db.jackFeedback.deleteMany).not.toHaveBeenCalled()
  })
})

describe("roomFeedback", () => {
  it("loads the room's ratings, oldest first, as the viewer sees them", async () => {
    db.jackFeedback.findMany.mockResolvedValue([
      { messageId: "r1", userId: "gray", rating: "up", note: null, user: { displayName: "Gray" } },
      { messageId: "r2", userId: "dylan", rating: "down", note: null, user: { displayName: "Dylan" } },
    ])
    const summaries = await roomFeedback("room-1", "gray")
    expect(db.jackFeedback.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { message: { roomId: "room-1" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }))
    expect(summaries.r1.mine).toEqual({ rating: "up", note: null })
    expect(summaries.r2).toMatchObject({ down: 1, mine: null })
  })
})
