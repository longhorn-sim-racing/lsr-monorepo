import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ event: { count: vi.fn(), findMany: vi.fn() }, eventRegistration: { groupBy: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { missingResultsWhere } from "@/lib/events"
import { CHECKS, draftEvents, lowRegistration, resultsMissing } from "./changes"

const NOW = new Date("2026-10-26T17:00:00Z") // Mon, noon Central
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000)

beforeEach(() => {
  db.event.count.mockResolvedValue(0)
  db.event.findMany.mockResolvedValue([])
  db.eventRegistration.groupBy.mockResolvedValue([])
})

it("registers the three event checks, linking to console pages", () => {
  expect(CHECKS.map((c) => [c.id, c.href])).toEqual([
    ["results.missing", "/admin/results"],
    ["events.drafts", "/admin/events"],
    ["events.low-registration", "/admin/events"],
  ])
})

describe("results not uploaded", () => {
  it("uses the Overview's rule, and links an upload that wasn't ingested", async () => {
    db.event.count.mockResolvedValue(2)
    db.event.findMany.mockResolvedValue([
      { id: "e1", title: "LSC Round 4 @ Spa", endsAtUtc: days(-9), rawResultUploads: [{ id: "u1" }] },
      { id: "e2", title: "LSC Round 5 @ Monza", endsAtUtc: days(-2), rawResultUploads: [] },
    ])
    const result = await resultsMissing.run({ now: NOW })
    expect(db.event.count).toHaveBeenCalledWith({ where: missingResultsWhere(NOW) })
    expect(result).toEqual({
      count: 2,
      severity: "warning",
      items: [
        { title: "LSC Round 4 @ Spa", href: "/admin/results/u1", detail: "Uploaded, not ingested · ended Sat, Oct 17" },
        { title: "LSC Round 5 @ Monza", href: "/admin/results?upload=1", detail: "No upload · ended Sat, Oct 24" },
      ],
    })
  })
})

describe("draft events", () => {
  it("lists drafts starting in the next two weeks first, then ones whose date just passed", async () => {
    db.event.count.mockResolvedValue(3)
    db.event.findMany.mockResolvedValue([
      { id: "old", title: "Social night", startsAtUtc: days(-3) },
      { id: "gm3", title: "GM 3", startsAtUtc: days(2) },
      { id: "lsc", title: "LSC Round 6", startsAtUtc: days(10) },
    ])
    const result = await draftEvents.run({ now: NOW })
    expect(db.event.count.mock.calls[0][0].where).toEqual({ status: "DRAFT", startsAtUtc: { gte: days(-14), lte: days(14) } })
    expect(result).toEqual({
      count: 3,
      severity: "warning",
      items: [
        { title: "GM 3", href: "/admin/events/gm3/edit", detail: "Still a draft · starts Wed, Oct 28 (in 2 days)" },
        { title: "LSC Round 6", href: "/admin/events/lsc/edit", detail: "Still a draft · starts Thu, Nov 5 (in 10 days)" },
        { title: "Social night", href: "/admin/events/old/edit", detail: "Still a draft · its date passed Fri, Oct 23" },
      ],
    })
  })

  it("is only info when nothing is less than a week out", async () => {
    db.event.count.mockResolvedValue(1)
    db.event.findMany.mockResolvedValue([{ id: "lsc", title: "LSC Round 6", startsAtUtc: days(10) }])
    expect((await draftEvents.run({ now: NOW })).severity).toBe("info")
  })
})

describe("low registration", () => {
  it("lists published events in the next week with a cap that are under half full", async () => {
    db.event.findMany.mockResolvedValue([
      { id: "gm3", title: "GM 3", startsAtUtc: days(1), registrationMax: 40 },
      { id: "lan", title: "LAN night", startsAtUtc: days(5), registrationMax: 20 },
      { id: "full", title: "Full one", startsAtUtc: days(3), registrationMax: 10 },
    ])
    db.eventRegistration.groupBy.mockResolvedValue([
      { eventId: "gm3", _count: { _all: 6 } },
      { eventId: "lan", _count: { _all: 9 } },
      { eventId: "full", _count: { _all: 10 } },
    ])
    const result = await lowRegistration.run({ now: NOW })
    expect(db.event.findMany.mock.calls[0][0].where).toEqual({
      startsAtUtc: { gt: NOW, lte: days(7) },
      registrationEnabled: true,
      registrationMax: { gt: 0 },
      OR: [{ status: "PUBLISHED" }, { status: "SCHEDULED", publishedAt: { lte: NOW } }],
    })
    expect(db.eventRegistration.groupBy.mock.calls[0][0].where).toEqual({ eventId: { in: ["gm3", "lan", "full"] }, status: "REGISTERED" })
    expect(result).toEqual({
      count: 2,
      severity: "warning",
      items: [
        { title: "GM 3: 6 of 40 registered", href: "/admin/events/gm3/manage", detail: "Starts Tue, Oct 27 (tomorrow)" },
        { title: "LAN night: 9 of 20 registered", href: "/admin/events/lan/manage", detail: "Starts Sat, Oct 31 (in 5 days)" },
      ],
    })
  })

  it("asks nothing more when no event qualifies", async () => {
    expect(await lowRegistration.run({ now: NOW })).toEqual({ count: 0, severity: "info", items: [] })
    expect(db.eventRegistration.groupBy).not.toHaveBeenCalled()
  })
})
