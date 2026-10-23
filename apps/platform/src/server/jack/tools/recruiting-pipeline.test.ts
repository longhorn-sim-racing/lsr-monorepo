import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ applicationTrack: { findMany: vi.fn() }, user: { findMany: vi.fn() } }))
const cycles = vi.hoisted(() => ({ listCycles: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/recruiting-cycle.service", () => cycles)

import { recruitingPipelineTool } from "./recruiting-pipeline"

const ctx = { roomId: "room-1", actor: { userId: "officer-1", displayName: "Gray" } }
const run = (input: Record<string, unknown>) => recruitingPipelineTool.run(recruitingPipelineTool.input.parse(input), ctx)

const cycle = (slug: string, isActive: boolean) => ({ id: `c-${slug}`, slug, name: slug === "fall-2026" ? "Fall 2026" : "Spring 2026", opensAt: new Date("2026-09-01"), closesAt: new Date("2026-10-31"), isActive, window: "open", drafts: 7, submitted: 3 })

function track(id: string, trackKey: string, status: string, application: Record<string, unknown>, reviews: { reviewerId: string; score: number | null }[] = []) {
  return {
    id,
    track: trackKey,
    status,
    decidedAt: null,
    application: { id: `app-${id}`, userId: `u-${id}`, fullName: `Applicant ${id}`, gradYear: 2028, major: "CS", submittedAt: new Date("2026-10-10T15:00:00Z"), autoSubmitted: false, user: { roles: [] }, ...application },
    reviews: reviews.map((r) => ({ ...r, createdAt: new Date("2026-10-12") })),
  }
}

beforeEach(() => {
  cycles.listCycles.mockResolvedValue([cycle("fall-2026", true), cycle("spring-2026", false)])
  db.user.findMany.mockResolvedValue([{ id: "gray", displayName: "Gray", handle: "gray" }])
  db.applicationTrack.findMany.mockImplementation(async ({ select }) => {
    const contact = select.application.select.eid === true
    const withContact = (row: ReturnType<typeof track>) =>
      contact ? { ...row, application: { ...row.application, eid: "ab12345", user: { ...row.application.user, email: "applicant@utexas.edu" } } } : row
    return [
      track("1", "media", "SUBMITTED", {}),
      track("2", "media", "IN_REVIEW", {}, [{ reviewerId: "gray", score: 4 }]),
      // An officer's application: Jack never sees its team, status or reviews
      track("3", "technology", "REJECTED", { fullName: "Dylan Officer", user: { roles: [{ role: { key: "officer" } }] } }, [{ reviewerId: "gray", score: 1 }]),
    ].map(withContact)
  })
})

describe("recruiting_pipeline", () => {
  it("summarizes the active round by default, leaving out drafts' count and officers' applications", async () => {
    const out = await run({})
    const body = JSON.parse(out.forModel)
    expect(db.applicationTrack.findMany.mock.calls[0][0].where).toEqual({ application: { cycleId: "c-fall-2026", state: "SUBMITTED" } })
    expect(body.round).toMatchObject({ name: "Fall 2026", slug: "fall-2026", active: true })
    expect(body.otherRounds.map((r: { slug: string }) => r.slug)).toEqual(["spring-2026"])
    expect(JSON.stringify(body)).not.toMatch(/drafts/)
    expect(body).toMatchObject({ applications: 2, teamApplications: 2, unreviewed: 1, averageScore: 4 })
    expect(body.officerApplicants).toMatchObject({ count: 1, applicants: [{ name: "Dylan Officer" }] })
    // Nothing about the officer's team, decision or score anywhere
    const technology = body.teams.find((t: { team: string }) => t.team === "Technology")
    expect(technology).toMatchObject({ total: 0, "Not moving forward": 0, reviews: 0, averageScore: null })
    expect(body.reviewers).toEqual([{ reviewer: "Gray (@gray)", reviews: 1, teamApplications: 1, averageScoreGiven: 4 }])
    expect(body.applicants).toBeUndefined()
    expect(out.label).toBe("Looked at recruiting for Fall 2026 (2 applicants)")
  })

  it("lists applicants by filter, with a link and no contact details unless asked", async () => {
    const body = JSON.parse((await run({ team: "media", unreviewed: true })).forModel)
    expect(body.matching).toBe(1)
    expect(body.applicants).toEqual([
      expect.objectContaining({ name: "Applicant 1", team: "Media", status: "New", reviews: 0, daysWithoutReview: expect.any(Number), link: "/admin/recruiting/app-1" }),
    ])
    expect(body.applicants[0]).not.toHaveProperty("email")
    expect(body.applicants[0]).not.toHaveProperty("eid")
    expect(db.applicationTrack.findMany.mock.calls[0][0].select.application.select.eid).toBe(false)
  })

  it("adds emails and EIDs only when an officer asked for them", async () => {
    const body = JSON.parse((await run({ applicants: true, contact: true })).forModel)
    expect(body.applicants[0]).toMatchObject({ email: "applicant@utexas.edu", eid: "ab12345" })
    // The officer applicant still isn't listed among applicants with a team or status
    expect(body.applicants.map((a: { name: string }) => a.name)).toEqual(["Applicant 1", "Applicant 2"])
  })

  it("filters by status, and never shows the officer's decision even when filtering for it", async () => {
    const body = JSON.parse((await run({ status: "REJECTED" })).forModel)
    expect(body.matching).toBe(0)
    expect(body.applicants).toEqual([])
  })

  it("picks a round by slug, and lists the rounds when it doesn't exist", async () => {
    await run({ round: "spring-2026" })
    expect(db.applicationTrack.findMany.mock.calls[0][0].where.application.cycleId).toBe("c-spring-2026")
    expect(await run({ round: "winter-2030" })).toMatchObject({ isError: true, forModel: 'No round "winter-2030". Rounds: fall-2026, spring-2026.' })
  })

  it("says so when there are no rounds yet", async () => {
    cycles.listCycles.mockResolvedValue([])
    expect((await run({})).forModel).toBe("There are no recruiting rounds yet.")
  })

  it("is deferred behind tool search, and takes only known teams and statuses", () => {
    expect(recruitingPipelineTool.deferred).toBe(true)
    expect(recruitingPipelineTool.input.safeParse({ team: "racing" }).success).toBe(false)
    expect(recruitingPipelineTool.input.safeParse({ status: "DRAFT" }).success).toBe(false)
  })
})
