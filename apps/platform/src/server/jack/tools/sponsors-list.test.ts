import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }))
const queries = vi.hoisted(() => ({ listProspects: vi.fn(), getProspectDetail: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/queries/sponsor-prospects", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/queries/sponsor-prospects")>()), ...queries }))

import type { ProspectRow } from "@/server/queries/sponsor-prospects"
import { sponsorsListTool } from "./sponsors-list"
import type { JackToolContext } from "./types"

const ctx: JackToolContext = { roomId: "room-1", actor: { userId: "u-ana", displayName: "Ana" } }
const DYLAN = { id: "u-dylan", displayName: "Dylan", handle: "dylan" }
const OCT = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T17:00:00Z`)

const row = (overrides: Partial<ProspectRow>): ProspectRow => ({
  id: "pr-1",
  company: "Apex Sim Rigs",
  website: "https://apexsimrigs.example/",
  contactName: "Jordan Lee",
  contactEmail: "jordan@apexsimrigs.example",
  contactRole: "Partnerships",
  stage: "talking",
  tierInterest: "gold",
  owner: DYLAN,
  nextStep: "Send the deck",
  nextStepDue: OCT(27),
  notes: "Met at the expo",
  lastContactAt: OCT(20),
  createdAt: OCT(1),
  updatedAt: OCT(20),
  lastActivity: { type: "meeting", occurredAt: OCT(20), summary: "Intro call" },
  lastTouchAt: OCT(20),
  quiet: false,
  nextStepOverdue: false,
  ...overrides,
})

async function call(input: unknown) {
  return sponsorsListTool.run(sponsorsListTool.input.parse(input), ctx)
}

beforeEach(() => {
  queries.listProspects.mockResolvedValue([
    row({}),
    row({ id: "pr-2", company: "Bolt Energy", stage: "contacted", owner: null, quiet: true, lastActivity: null, lastTouchAt: OCT(1), contactEmail: null }),
    row({ id: "pr-3", company: "Crest Wheels", stage: "declined", owner: null }),
  ])
  db.user.findUnique.mockResolvedValue({ id: "u-dylan" })
})

describe("sponsors_list", () => {
  it("is deferred, and found by its sponsor words", () => {
    expect(sponsorsListTool.deferred).toBe(true)
    expect(sponsorsListTool.description).toMatch(/Sponsor prospects/)
  })

  it("lists the prospects being worked on (not declined or dormant), most advanced first, without contact emails", async () => {
    const result = await call({})
    const data = JSON.parse(result.forModel)
    expect(data.prospects.map((p: { company: string }) => p.company)).toEqual(["Apex Sim Rigs", "Bolt Energy"])
    expect(data.prospects[0]).toMatchObject({ id: "pr-1", stage: "talking", tierInterest: "Gold", owner: "Dylan (@dylan)", contact: "Jordan Lee, Partnerships", nextStepDue: "Tue 2026-10-27", link: "/admin/sponsors/pr-1" })
    expect(result.forModel).not.toContain("jordan@apexsimrigs.example")
    expect(data.byStage).toMatchObject({ talking: 1, contacted: 1, declined: 1 })
    expect(data.quiet).toBe(1)
    expect(data.onTheWebsite.sponsors.length).toBeGreaterThan(0)
    expect(result.displays?.map((d) => d.kind)).toEqual(["stats", "table"])
  })

  it("adds contact emails only when asked, and filters by owner, stage, quiet and words", async () => {
    expect((await call({ contact: true })).forModel).toContain("jordan@apexsimrigs.example")
    expect(JSON.parse((await call({ owner: "@Dylan" })).forModel).prospects.map((p: { id: string }) => p.id)).toEqual(["pr-1"])
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { handle: "dylan" }, select: { id: true } })
    expect(JSON.parse((await call({ quiet: true })).forModel).prospects.map((p: { id: string }) => p.id)).toEqual(["pr-2"])
    expect(JSON.parse((await call({ stages: ["declined"] })).forModel).prospects.map((p: { id: string }) => p.id)).toEqual(["pr-3"])
    // A search looks at every stage, declined ones last
    expect(JSON.parse((await call({ query: "expo jordan" })).forModel).prospects.map((p: { id: string }) => p.id)).toEqual(["pr-1", "pr-2", "pr-3"])
    expect(JSON.parse((await call({ query: "bolt" })).forModel).prospects.map((p: { id: string }) => p.id)).toEqual(["pr-2"])
  })

  it("says when a handle isn't anyone's", async () => {
    db.user.findUnique.mockResolvedValue(null)
    expect(await call({ owner: "ghost" })).toMatchObject({ isError: true, forModel: expect.stringMatching(/@ghost/) })
  })

  it("opens one prospect with its notes and timeline", async () => {
    queries.getProspectDetail.mockResolvedValue({
      ...row({}),
      createdBy: null,
      createdById: null,
      activities: [
        { id: "a2", type: "meeting", summary: "Intro call", occurredAt: OCT(20), createdAt: OCT(20), byId: "u-dylan", by: DYLAN },
        { id: "a1", type: "email_sent", summary: "Cold email", occurredAt: OCT(5), createdAt: OCT(5), byId: "u-gone", by: null },
      ],
    })
    const result = await call({ prospectId: "pr-1" })
    const data = JSON.parse(result.forModel)
    expect(data.prospect).toMatchObject({ company: "Apex Sim Rigs", notes: "Met at the expo" })
    expect(data.prospect.contactEmail).toBeUndefined()
    expect(data.activities).toEqual([
      { at: "Tue 2026-10-20 12:00 CT", type: "meeting", summary: "Intro call", by: "Dylan" },
      { at: "Mon 2026-10-05 12:00 CT", type: "email_sent", summary: "Cold email", by: "Former officer" },
    ])
    expect(result.displays?.[0]).toMatchObject({ kind: "links", items: [{ url: "/admin/sponsors/pr-1" }] })
    queries.getProspectDetail.mockResolvedValue(null)
    expect(await call({ prospectId: "pr-9" })).toMatchObject({ isError: true })
  })
})
