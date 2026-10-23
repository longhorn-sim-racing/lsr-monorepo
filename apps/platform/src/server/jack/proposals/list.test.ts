import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  jackProposal: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
  user: { findMany: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("./registry", () => ({ PROPOSAL_KINDS: [{ kind: "page.update" }] }))

import { listProposals, PROPOSALS_PAGE_SIZE } from "./list"

const NOW = new Date("2026-10-22T15:00:00Z")
const proposal = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  roomId: "room-1",
  messageId: "m1",
  kind: "page.update",
  title: `Proposal ${id}`,
  summary: "",
  status,
  result: null,
  createdAt: NOW,
  decidedAt: null,
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  proposedForId: "u1",
  decidedById: null,
  room: { title: "Planning" },
  ...extra,
})

/** Open = pending (unexpired) or applying: the query shape listProposals uses for them */
const isOpenQuery = (where: unknown) => JSON.stringify(where).includes('"APPLYING"') && !JSON.stringify(where).includes('"NOT"')

beforeEach(() => {
  db.jackProposal.groupBy.mockImplementation(async ({ by }: { by: string[] }) =>
    by[0] === "status" ? [{ status: "PENDING", _count: { _all: 3 } }, { status: "APPLIED", _count: { _all: 70 } }] : [{ kind: "event.update", _count: { _all: 1 } }],
  )
  db.user.findMany.mockResolvedValue([{ id: "u1", displayName: "Ana" }])
})

describe("listProposals", () => {
  it("puts open proposals first, then fills the page from the rest", async () => {
    // 73 in all: 3 open, 70 decided
    db.jackProposal.count.mockImplementation(async ({ where }: { where: unknown }) => (JSON.stringify(where).includes('"lte"') && !JSON.stringify(where).includes("AND") ? 1 : isOpenQuery(where) ? 3 : 73))
    db.jackProposal.findMany.mockImplementation(async ({ where, skip, take }: { where: unknown; skip: number; take: number }) =>
      isOpenQuery(where) ? [proposal("o1", "PENDING"), proposal("o2", "APPLYING"), proposal("o3", "PENDING")].slice(skip, skip + take) : Array.from({ length: take }, (_, i) => proposal(`d${skip + i}`, "APPLIED")),
    )

    const first = await listProposals({ status: null, kind: null, page: 1 }, NOW)
    expect(first.items.slice(0, 4).map((item) => item.id)).toEqual(["o1", "o2", "o3", "d0"])
    expect(first.items).toHaveLength(PROPOSALS_PAGE_SIZE)
    expect(first.pageCount).toBe(2)
    expect(first.items[0]).toMatchObject({ roomTitle: "Planning", proposedFor: "Ana", decidedBy: null })

    db.jackProposal.findMany.mockClear()
    const second = await listProposals({ status: null, kind: null, page: 2 }, NOW)
    // Page 2 starts 47 rows into the decided ones (50 minus the 3 open ones on page 1), and asks for no open ones
    expect(second.items[0].id).toBe("d47")
    expect(db.jackProposal.findMany).toHaveBeenCalledTimes(1)
  })

  it("counts an expired pending proposal as stale, and lists the kinds to filter by", async () => {
    db.jackProposal.count.mockResolvedValue(1)
    db.jackProposal.findMany.mockImplementation(async ({ where }: { where: unknown }) => (isOpenQuery(where) ? [] : [proposal("x", "PENDING", { expiresAt: new Date(NOW.getTime() - 1) })]))
    const list = await listProposals({ status: "STALE", kind: null, page: 1 }, NOW)
    expect(list.items[0]).toMatchObject({ id: "x", status: "STALE", result: "Nobody applied it within 14 days." })
    expect(list.counts).toMatchObject({ PENDING: 2, STALE: 1, APPLIED: 70 })
    expect(list.kinds).toEqual(["event.update", "page.update"])
  })
})
