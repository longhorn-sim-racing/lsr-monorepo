import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ jackFeedback: { count: vi.fn(), findMany: vi.fn() } }))
const spend = vi.hoisted(() => ({ getMonthSpend: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/jack/spend", () => spend)

import { CHECKS, jackFeedbackNotes, jackSpendNearCap } from "./decks-rooms"

const NOW = new Date("2026-10-22T17:00:00Z")
const month = (totalUsd: number, budgetUsd = 50) => ({ month: "October", totalUsd, budgetUsd, byPersona: { jack: totalUsd, lift: 0, stand: 0 } })

beforeEach(() => {
  db.jackFeedback.count.mockResolvedValue(0)
  db.jackFeedback.findMany.mockResolvedValue([])
})

describe("jack.spend", () => {
  it("is quiet under 80% of the cap", async () => {
    spend.getMonthSpend.mockResolvedValue(month(39.99))
    expect(await jackSpendNearCap.run({ now: NOW })).toEqual({ count: 0, severity: "info", items: [] })
    expect(spend.getMonthSpend).toHaveBeenCalledWith(NOW)
  })

  it("warns from 80%, and is urgent once the cap stops replies", async () => {
    spend.getMonthSpend.mockResolvedValue(month(41))
    expect(await jackSpendNearCap.run({ now: NOW })).toEqual({
      count: 1,
      severity: "warning",
      items: [{ title: "October: $41.00 of $50 spent", href: "/admin/jack/usage", detail: "82% of the cap" }],
    })
    spend.getMonthSpend.mockResolvedValue(month(50.2))
    expect(await jackSpendNearCap.run({ now: NOW })).toMatchObject({ count: 1, severity: "danger", items: [{ detail: "Jack stops answering until the 1st" }] })
    // A cap of $0 means Jack never answers
    spend.getMonthSpend.mockResolvedValue(month(0, 0))
    expect(await jackSpendNearCap.run({ now: NOW })).toMatchObject({ severity: "danger" })
  })
})

describe("jack.feedback", () => {
  it("lists the last week's thumbs-down with a note by room, linking to the reply, never the note", async () => {
    db.jackFeedback.count.mockResolvedValue(6)
    db.jackFeedback.findMany.mockResolvedValue([{ createdAt: new Date("2026-10-21T15:00:00Z"), message: { id: "r1", roomId: "room-1", room: { title: "GM 2" } } }])
    const result = await jackFeedbackNotes.run({ now: NOW })

    const where = db.jackFeedback.count.mock.calls[0][0].where
    expect(where).toEqual({ rating: "down", note: { not: null }, createdAt: { gte: new Date("2026-10-15T17:00:00Z"), lte: NOW } })
    expect(db.jackFeedback.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, take: 5 }))
    expect(result).toEqual({ count: 6, severity: "info", items: [{ title: "Thumbs-down in “GM 2”", href: "/admin/jack/room-1?m=r1", detail: "Rated Oct 21" }] })
  })

  it("link to the Usage page from the console", () => {
    expect(CHECKS.map((check) => [check.id, check.href])).toEqual([
      ["jack.spend", "/admin/jack/usage"],
      ["jack.feedback", "/admin/jack/usage#feedback"],
    ])
  })
})
