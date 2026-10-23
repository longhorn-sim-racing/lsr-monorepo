import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  jackFeedback: { count: vi.fn(), findMany: vi.fn() },
  instagramPublish: { count: vi.fn(), findMany: vi.fn() },
  jackDeck: { findMany: vi.fn() },
}))
const spend = vi.hoisted(() => ({ getMonthSpend: vi.fn() }))
const token = vi.hoisted(() => ({ publishAccount: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/jack/spend", () => spend)
vi.mock("@/server/connectors/instagram/publish-token", () => token)

import { CHECKS, instagramPublishNeedsAttention, jackFeedbackNotes, jackSpendNearCap } from "./decks-rooms"

const NOW = new Date("2026-10-22T17:00:00Z")
const month = (totalUsd: number, budgetUsd = 50) => ({ month: "October", totalUsd, budgetUsd, byPersona: { jack: totalUsd, lift: 0, stand: 0 } })

beforeEach(() => {
  db.jackFeedback.count.mockResolvedValue(0)
  db.jackFeedback.findMany.mockResolvedValue([])
  db.instagramPublish.count.mockResolvedValue(0)
  db.instagramPublish.findMany.mockResolvedValue([])
  db.jackDeck.findMany.mockResolvedValue([{ id: "deck-1", title: "GM 2 recap" }])
  token.publishAccount.mockResolvedValue({ connected: false })
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

  it("link to the Usage page and the publish history from the console", () => {
    expect(CHECKS.map((check) => [check.id, check.href])).toEqual([
      ["jack.spend", "/admin/jack/usage"],
      ["jack.feedback", "/admin/jack/usage#feedback"],
      ["instagram-publish.attention", "/admin/instagram#publishing"],
    ])
  })
})

describe("instagram-publish.attention", () => {
  it("is quiet when nothing failed, nothing waits and the token is fine", async () => {
    token.publishAccount.mockResolvedValue({ connected: true, tokenExpiresAt: "2026-12-01T00:00:00Z", refreshError: null })
    expect(await instagramPublishNeedsAttention.run({ now: NOW })).toEqual({ count: 0, severity: "info", items: [] })
  })

  it("lists posts waiting over 20 minutes and the week's failures by deck, never Instagram's error text", async () => {
    db.instagramPublish.findMany.mockImplementation(async ({ where }: { where: { status: unknown } }) =>
      where.status === "failed"
        ? [{ deckId: "deck-1", mediaType: "CAROUSEL", updatedAt: new Date("2026-10-21T15:00:00Z") }]
        : [{ deckId: "gone", mediaType: "STORIES", createdAt: new Date("2026-10-22T16:00:00Z") }],
    )
    db.instagramPublish.count.mockImplementation(async ({ where }: { where: { status: unknown } }) => (where.status === "failed" ? 3 : 1))
    const result = await instagramPublishNeedsAttention.run({ now: NOW })

    const [failedQuery, stuckQuery] = db.instagramPublish.findMany.mock.calls.map((call) => call[0])
    expect(failedQuery.where).toEqual({ status: "failed", updatedAt: { gte: new Date("2026-10-15T17:00:00Z"), lte: NOW } })
    expect(stuckQuery.where).toEqual({ status: { in: ["queued", "containers", "publishing"] }, createdAt: { lt: new Date("2026-10-22T16:40:00Z") } })
    expect(result).toEqual({
      count: 4,
      severity: "warning",
      items: [
        { title: "Still waiting on Instagram: a story of “a deleted deck”", href: "/admin/instagram#publishing", detail: "Approved Oct 22, 11:00 AM CT" },
        { title: "Couldn't post a carousel of “GM 2 recap”", href: "/admin/instagram#publishing", detail: "Oct 21, 10:00 AM CT" },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/error/i)
  })

  it("is urgent when the publishing token couldn't be renewed, and warns when it runs out within 10 days", async () => {
    token.publishAccount.mockResolvedValue({ connected: true, tokenExpiresAt: "2026-10-25T00:00:00Z", refreshError: "Instagram says the publishing token has expired" })
    expect(await instagramPublishNeedsAttention.run({ now: NOW })).toMatchObject({
      count: 1,
      severity: "danger",
      items: [{ title: "The Instagram publishing token couldn't be renewed: an admin pastes a new one", detail: "Runs out Oct 24" }],
    })
    token.publishAccount.mockResolvedValue({ connected: true, tokenExpiresAt: "2026-10-28T00:00:00Z", refreshError: null })
    expect(await instagramPublishNeedsAttention.run({ now: NOW })).toMatchObject({ count: 1, severity: "warning", items: [{ title: expect.stringMatching(/runs out soon/) }] })
    // Not connected: nothing to renew
    token.publishAccount.mockResolvedValue({ connected: false, refreshError: "old" })
    expect(await instagramPublishNeedsAttention.run({ now: NOW })).toMatchObject({ count: 0 })
  })
})
