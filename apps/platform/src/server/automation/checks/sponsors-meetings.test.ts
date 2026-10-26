import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ actionItem: { findMany: vi.fn() }, sponsorProspect: { findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { CHECKS, overdueActionItems, quietProspects } from "./sponsors-meetings"

const NOW = new Date("2026-10-22T17:00:00Z") // Thu Oct 22, noon Central
const due = (day: string) => new Date(`${day}T05:00:00Z`)
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
const DYLAN = { displayName: "Dylan", handle: "dylan" }
const ALEX = { displayName: "Alex", handle: "alex" }

beforeEach(() => {
  db.actionItem.findMany.mockResolvedValue([])
  db.sponsorProspect.findMany.mockResolvedValue([])
})

it("registers both checks, linking to console pages", () => {
  expect(CHECKS.map((c) => [c.id, c.href])).toEqual([
    ["action_items.overdue", "/admin/action-items?status=overdue"],
    ["sponsors.quiet", "/admin/sponsors?view=quiet"],
  ])
})

describe("overdue action items", () => {
  it("counts them per owner, oldest first, with names and counts only", async () => {
    db.actionItem.findMany.mockResolvedValue([
      { status: "open", dueAt: due("2026-10-20"), owner: DYLAN },
      { status: "open", dueAt: due("2026-10-10"), owner: DYLAN },
      { status: "open", dueAt: due("2026-10-21"), owner: ALEX },
      { status: "open", dueAt: due("2026-10-19"), owner: null },
      // Due today: not overdue yet
      { status: "open", dueAt: due("2026-10-22"), owner: ALEX },
    ])
    const result = await overdueActionItems.run({ now: NOW })
    expect(db.actionItem.findMany.mock.calls[0][0].where).toEqual({ status: "open", dueAt: { not: null, lt: NOW } })
    expect(result).toEqual({
      count: 4,
      severity: "warning",
      items: [
        { title: "Dylan: 2 overdue", href: "/admin/action-items?owner=dylan&status=overdue", detail: "Oldest due 2026-10-10 (12 days ago)" },
        { title: "No owner: 1 overdue", href: "/admin/action-items?owner=none&status=overdue", detail: "Oldest due 2026-10-19 (3 days ago)" },
        { title: "Alex: 1 overdue", href: "/admin/action-items?owner=alex&status=overdue", detail: "Oldest due 2026-10-21 (1 day ago)" },
      ],
      // Items are owners, all listed: "and N more" counts owners, not the 4 items
      moreItems: 0,
    })
  })

  it("is only info while nothing is over a week late, and empty with nothing overdue", async () => {
    db.actionItem.findMany.mockResolvedValue([{ status: "open", dueAt: due("2026-10-19"), owner: DYLAN }])
    expect((await overdueActionItems.run({ now: NOW })).severity).toBe("info")
    db.actionItem.findMany.mockResolvedValue([])
    expect(await overdueActionItems.run({ now: NOW })).toEqual({ count: 0, severity: "info", items: [], moreItems: 0 })
  })
})

describe("quiet prospects", () => {
  it("lists contacted and talking prospects with nothing logged for 21 days, quietest first", async () => {
    db.sponsorProspect.findMany.mockResolvedValue([
      { id: "pr-1", company: "Apex Sim Rigs", stage: "talking", createdAt: daysAgo(90), lastContactAt: daysAgo(30), owner: { handle: "dylan" }, activities: [{ occurredAt: daysAgo(25) }] },
      { id: "pr-2", company: "Bolt Energy", stage: "contacted", createdAt: daysAgo(60), lastContactAt: null, owner: null, activities: [] },
      { id: "pr-3", company: "Crest Wheels", stage: "talking", createdAt: daysAgo(90), lastContactAt: daysAgo(3), owner: null, activities: [{ occurredAt: daysAgo(3) }] },
    ])
    const result = await quietProspects.run({ now: NOW })
    expect(db.sponsorProspect.findMany.mock.calls[0][0].where).toEqual({ stage: { in: ["contacted", "talking"] } })
    expect(result).toEqual({
      count: 2,
      severity: "warning",
      items: [
        { title: "Bolt Energy", href: "/admin/sponsors/pr-2", detail: "Contacted, nothing logged for 60 days · no owner" },
        { title: "Apex Sim Rigs", href: "/admin/sponsors/pr-1", detail: "Talking, nothing logged for 25 days · @dylan" },
      ],
    })
  })
})
