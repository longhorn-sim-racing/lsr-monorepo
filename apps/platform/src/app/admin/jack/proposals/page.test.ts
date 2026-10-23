import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProposalList, ProposalListItem } from "@/server/jack/proposals/list"

const guards = vi.hoisted(() => ({ requireOfficerPage: vi.fn() }))
const list = vi.hoisted(() => ({ listProposals: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/jack/proposals/list", () => list)
vi.mock("./proposals-filters", () => ({ ProposalsFilters: () => null }))

import JackProposalsPage from "./page"

const AT = new Date("2026-10-22T15:00:00Z")
const item = (id: string, extra: Partial<ProposalListItem> = {}): ProposalListItem => ({
  id,
  roomId: `room-${id}`,
  roomTitle: "Planning",
  roomArchived: false,
  messageId: null,
  kind: "page.update",
  title: `Proposal ${id}`,
  summary: "",
  status: "PENDING",
  result: null,
  createdAt: AT,
  decidedAt: null,
  proposedFor: "Ana",
  decidedBy: null,
  ...extra,
})

function listOf(items: ProposalListItem[]): ProposalList {
  return { items, total: items.length, pageCount: 1, counts: { PENDING: 2, APPLYING: 0, APPLIED: 1, DISCARDED: 0, FAILED: 0, STALE: 0, SUPERSEDED: 0 }, kinds: ["page.update"] }
}

const render = async () => renderToStaticMarkup(await JackProposalsPage({ searchParams: Promise.resolve({}) }))

beforeEach(() => {
  guards.requireOfficerPage.mockResolvedValue({ id: "officer-1", displayName: "Gray" })
})

describe("the Proposals page", () => {
  it("marks a proposal whose room is archived, and says a pending one waits for the room to come back", async () => {
    list.listProposals.mockResolvedValue(
      listOf([
        item("held", { roomTitle: "Old plans", roomArchived: true }),
        item("open"),
        item("done", { status: "APPLIED", roomArchived: true, result: "Saved the page.", decidedAt: AT, decidedBy: "Gray" }),
      ]),
    )
    const html = await render()
    const rows = html.split("<tr").slice(2)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain("Old plans")
    expect(rows[0]).toContain("Archived")
    expect(rows[0]).toContain("On hold: unarchive its room to apply or discard it.")
    expect(rows[1]).not.toContain("Archived")
    expect(rows[1]).not.toContain("On hold")
    // Already decided: the room is marked, but nothing is on hold
    expect(rows[2]).toContain("Archived")
    expect(rows[2]).not.toContain("On hold")
    expect(guards.requireOfficerPage).toHaveBeenCalled()
  })
})
