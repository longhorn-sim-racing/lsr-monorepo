import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ recruitingCycle: { findMany: vi.fn() }, applicationTrack: { findMany: vi.fn() }, user: { findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { CHECKS, unreviewedApplications } from "./club-data"

const now = new Date("2026-10-22T17:00:00Z")
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)

function track(id: string, trackKey: string, status: string, submittedDaysAgo: number, { officer = false, reviewed = false } = {}) {
  return {
    id,
    track: trackKey,
    status,
    decidedAt: null,
    application: { id: `a${id}`, userId: `u${id}`, fullName: `Private Name ${id}`, gradYear: 2028, major: "CS", submittedAt: daysAgo(submittedDaysAgo), autoSubmitted: false, user: { roles: officer ? [{ role: { key: "officer" } }] : [] } },
    reviews: reviewed ? [{ reviewerId: "gray", score: 4, createdAt: daysAgo(1) }] : [],
  }
}

beforeEach(() => {
  db.recruitingCycle.findMany.mockResolvedValue([{ id: "c1", slug: "fall-2026", name: "Fall 2026" }])
  db.applicationTrack.findMany.mockResolvedValue([
    track("1", "media", "SUBMITTED", 9),
    track("2", "media", "IN_REVIEW", 2),
    track("3", "media", "SUBMITTED", 3, { reviewed: true }),
    track("4", "technology", "ACCEPTED", 12),
    track("5", "technology", "SUBMITTED", 20, { officer: true }),
  ])
})

describe("the unreviewed applications check", () => {
  it("is registered with a console link", () => {
    expect(CHECKS.map((c) => c.id)).toEqual(["recruiting.unreviewed"])
    expect(unreviewedApplications.href).toBe("/admin/recruiting")
  })

  it("looks at the active round and rounds closed in the last 30 days, as of the digest's time", async () => {
    await unreviewedApplications.run({ now })
    expect(db.recruitingCycle.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ isActive: true }, { closesAt: { gte: daysAgo(30), lte: now } }],
      opensAt: { lte: now },
    })
  })

  it("counts undecided applications with no review per team, without names or officers' applications", async () => {
    const result = await unreviewedApplications.run({ now })
    expect(result).toEqual({
      count: 2,
      severity: "warning",
      items: [{ title: "Media: 2 applications with no review", href: "/admin/recruiting?cycle=fall-2026&team=media", detail: "Oldest waiting 9 days" }],
      moreItems: 0,
    })
    expect(JSON.stringify(result)).not.toMatch(/Private Name/)
  })

  it("is only info while nothing has waited a week, and empty with nothing waiting", async () => {
    db.applicationTrack.findMany.mockResolvedValue([track("1", "media", "SUBMITTED", 2)])
    expect(await unreviewedApplications.run({ now })).toMatchObject({ count: 1, severity: "info" })
    db.applicationTrack.findMany.mockResolvedValue([track("4", "technology", "ACCEPTED", 12)])
    expect(await unreviewedApplications.run({ now })).toEqual({ count: 0, severity: "info", items: [], moreItems: 0 })
  })
})
