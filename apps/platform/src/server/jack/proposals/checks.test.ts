import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ jackProposal: { count: vi.fn(), findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { pendingProposals, staleProposals } from "./checks"

const NOW = new Date("2026-10-26T17:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
const row = (overrides: Record<string, unknown> = {}) => ({
  title: "Change GM 2's start time",
  roomId: "room-1",
  messageId: "msg-1",
  status: "PENDING",
  createdAt: daysAgo(1),
  updatedAt: daysAgo(1),
  expiresAt: new Date(NOW.getTime() + 13 * 86_400_000),
  room: { title: "GM planning" },
  ...overrides,
})

beforeEach(() => {
  db.jackProposal.count.mockResolvedValue(0)
  db.jackProposal.findMany.mockResolvedValue([])
})

describe("pending proposals", () => {
  it("counts the ones still waiting (not expired), oldest first, linking to the reply that proposed each", async () => {
    db.jackProposal.count.mockResolvedValue(7)
    db.jackProposal.findMany.mockResolvedValue([row({ createdAt: daysAgo(5) }), row({ createdAt: NOW, messageId: null, room: { title: null } })])
    const result = await pendingProposals.run({ now: NOW })
    const where = { status: "PENDING", expiresAt: { gt: NOW } }
    expect(db.jackProposal.count).toHaveBeenCalledWith({ where })
    expect(db.jackProposal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 5 }))
    expect(result).toEqual({
      count: 7,
      severity: "warning",
      items: [
        { title: "Change GM 2's start time", href: "/admin/jack/room-1?m=msg-1", detail: "In “GM planning”, waiting 5 days · expires Nov 8" },
        { title: "Change GM 2's start time", href: "/admin/jack/room-1", detail: "In “Untitled room”, waiting since today · expires Nov 8" },
      ],
    })
    expect(pendingProposals.href).toBe("/admin/jack/proposals?status=PENDING")
  })

  it("is only info while none has waited more than three days", async () => {
    db.jackProposal.count.mockResolvedValue(1)
    db.jackProposal.findMany.mockResolvedValue([row({ createdAt: daysAgo(3) })])
    expect((await pendingProposals.run({ now: NOW })).severity).toBe("info")
  })
})

describe("stale proposals", () => {
  it("lists the week's stale ones, an expired pending one included, as information", async () => {
    db.jackProposal.count.mockResolvedValue(2)
    db.jackProposal.findMany.mockResolvedValue([row({ status: "STALE", updatedAt: daysAgo(2) }), row({ status: "PENDING", expiresAt: daysAgo(1) })])
    const result = await staleProposals.run({ now: NOW })
    expect(db.jackProposal.count.mock.calls[0][0].where).toEqual({
      OR: [
        { status: "STALE", updatedAt: { gte: daysAgo(7), lte: NOW } },
        { status: "PENDING", expiresAt: { gte: daysAgo(7), lte: NOW } },
      ],
    })
    expect(result).toMatchObject({ count: 2, severity: "info" })
    expect(result.items.map((i) => i.detail)).toEqual(["In “GM planning” · stale since Oct 24", "In “GM planning” · nobody applied it by Oct 25"])
  })
})
