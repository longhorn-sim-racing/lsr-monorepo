import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  knowledgeEntry: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
  jackRoom: { findMany: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { getKnowledgeEntryDetail } from "./queries"

const AT = new Date("2026-10-22T17:00:00.000Z")

function entry(askedBy: unknown) {
  return {
    id: "k-1",
    title: "Dues this semester",
    createdById: "u-dylan",
    updatedById: "u-dylan",
    reviewedById: null,
    archivedAt: null,
    reviewedAt: null,
    owner: null,
    provenance: { roomId: "room-1", replyId: "reply-1", messageIds: ["msg-1"], askedBy, tools: [], at: AT.toISOString() },
    versions: [{ id: "v-1", title: "Dues this semester", body: "No dues.", tags: [], via: "jack", roomId: "room-1", createdAt: AT, editedById: "u-dylan" }],
  }
}

beforeEach(() => {
  db.jackRoom.findMany.mockResolvedValue([{ id: "room-1", title: "Budget" }])
  db.user.findMany.mockResolvedValue([{ id: "u-dylan", displayName: "Dylan", handle: "dylan" }])
})

describe("getKnowledgeEntryDetail", () => {
  it("names who asked from their account, not from the entry", async () => {
    db.knowledgeEntry.findUnique.mockResolvedValue(entry({ userId: "u-dylan" }))
    const detail = await getKnowledgeEntryDetail("k-1")
    expect(detail?.askedBy).toEqual({ id: "u-dylan", name: "Dylan", handle: "dylan" })
    expect(db.user.findMany.mock.calls[0][0].where.id.in).toContain("u-dylan")
  })

  it("shows a deleted account's asker without a name, even where an old entry saved one", async () => {
    db.knowledgeEntry.findUnique.mockResolvedValue(entry({ userId: "u-gone", name: "Avery Lane" }))
    const detail = await getKnowledgeEntryDetail("k-1")
    // The page shows this as "Former officer"
    expect(detail?.askedBy).toEqual({ id: "u-gone", name: null, handle: null })
    expect(JSON.stringify(detail?.provenance)).not.toContain("Avery")
  })

  it("has no asker for a save from a script or a proposal with nobody behind it", async () => {
    db.knowledgeEntry.findUnique.mockResolvedValue(entry({ userId: null }))
    expect((await getKnowledgeEntryDetail("k-1"))?.askedBy).toBeNull()
    db.knowledgeEntry.findUnique.mockResolvedValue({ ...entry(null), provenance: null })
    const detail = await getKnowledgeEntryDetail("k-1")
    expect([detail?.askedBy, detail?.provenance]).toEqual([null, null])
  })
})
