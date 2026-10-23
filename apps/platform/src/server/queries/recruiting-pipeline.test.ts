import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ applicationTrack: { findMany: vi.fn() }, user: { findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { applyPipelineRules, getPipelinePanel, isUnreviewed, loadPipelineRows, summarizePipeline, type PipelineRow } from "./recruiting-pipeline"

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 15))

function row(id: string, track: string, status: PipelineRow["status"], application: Partial<PipelineRow["application"]>, reviews: PipelineRow["reviews"] = []): PipelineRow {
  return {
    id,
    track,
    status,
    decidedAt: null,
    application: { id: `app-${id}`, userId: `user-${id}`, fullName: `Applicant ${id}`, gradYear: 2028, major: "CS", submittedAt: day(10), autoSubmitted: false, officer: false, ...application },
    reviews,
  }
}

const review = (reviewerId: string, score: number | null) => ({ reviewerId, score, createdAt: day(12) })

const rows: PipelineRow[] = [
  row("1", "media", "SUBMITTED", { submittedAt: day(8) }),
  row("2", "media", "IN_REVIEW", {}, [review("gray", 4), review("alex", 2)]),
  row("3", "technology", "INTERVIEW", {}, [review("gray", 5)]),
  row("4", "technology", "ACCEPTED", {}),
  // An officer who applied: their review must never show through Jack
  row("5", "technology", "IN_REVIEW", { userId: "officer-dylan", officer: true, fullName: "Dylan" }, [review("gray", 3)]),
  // The same applicant on a second team
  row("6", "business", "SUBMITTED", { id: "app-1", userId: "user-1", submittedAt: day(8) }),
]

beforeEach(() => {
  db.user.findMany.mockResolvedValue([
    { id: "gray", displayName: "Gray", handle: "gray" },
    { id: "alex", displayName: "Alex", handle: "alex" },
  ])
})

describe("the pipeline rules", () => {
  it("Jack's rule leaves out everything about officers' and admins' applications but that they applied", () => {
    const { rows: visible, hidden } = applyPipelineRules(rows, { hideOfficerApplicants: true, viewerId: null })
    expect(visible.map((r) => r.id)).toEqual(["1", "2", "3", "4", "6"])
    expect(hidden).toEqual([{ applicationId: "app-5", fullName: "Dylan", submittedAt: day(10) }])
    const summary = summarizePipeline(visible)
    expect(summary.reviewers.find((r) => r.reviewerId === "gray")).toEqual({ reviewerId: "gray", reviews: 2, teamApplications: 2, averageScore: 4.5 })
    expect(summary.teams.find((t) => t.team === "technology")!.total).toBe(2)
  })

  it("the admin page's rule only drops the viewer's own reviews, and counts everyone", () => {
    const { rows: visible, hidden } = applyPipelineRules(rows, { hideOfficerApplicants: false, viewerId: "officer-dylan" })
    expect(hidden).toEqual([])
    expect(visible.find((r) => r.id === "5")).toMatchObject({ reviews: [], own: true })
    expect(visible.find((r) => r.id === "2")!.reviews).toHaveLength(2)
    expect(visible.filter((r) => r.own).map((r) => r.id)).toEqual(["5"])
  })

  it("doesn't count the viewer's own application as unreviewed or waiting, since its reviews are hidden", () => {
    const mine = [row("7", "media", "SUBMITTED", { userId: "me", submittedAt: day(1) }, [review("gray", 5)]), row("8", "media", "SUBMITTED", { submittedAt: day(9) })]
    const summary = summarizePipeline(applyPipelineRules(mine, { hideOfficerApplicants: false, viewerId: "me" }).rows)
    const media = summary.teams.find((t) => t.team === "media")!
    expect(media).toMatchObject({ total: 2, unreviewed: 1, reviews: 0, oldestUnreviewedAt: day(9) })
    expect(summary.unreviewed).toBe(1)
  })
})

describe("isUnreviewed", () => {
  it("means no reviews and no decision yet", () => {
    expect(isUnreviewed({ status: "SUBMITTED", reviews: [] })).toBe(true)
    expect(isUnreviewed({ status: "INTERVIEW", reviews: [] })).toBe(true)
    expect(isUnreviewed({ status: "ACCEPTED", reviews: [] })).toBe(false)
    expect(isUnreviewed({ status: "REJECTED", reviews: [] })).toBe(false)
    expect(isUnreviewed({ status: "SUBMITTED", reviews: [review("gray", null)] })).toBe(false)
  })
})

describe("summarizePipeline", () => {
  const summary = summarizePipeline(applyPipelineRules(rows, { hideOfficerApplicants: true, viewerId: null }).rows)

  it("counts people and team applications, per team and status, every team listed in order", () => {
    expect(summary).toMatchObject({ applications: 4, teamApplications: 5, unreviewed: 2, averageScore: 3.67 })
    expect(summary.teams.map((t) => [t.team, t.total, t.unreviewed])).toEqual([
      ["technology", 2, 0],
      ["community", 0, 0],
      ["media", 2, 1],
      ["competition", 0, 0],
      ["business", 1, 1],
    ])
    expect(summary.teams[2].byStatus).toEqual({ SUBMITTED: 1, IN_REVIEW: 1, INTERVIEW: 0, ACCEPTED: 0, REJECTED: 0 })
  })

  it("summarizes scores per team and finds the longest wait", () => {
    const media = summary.teams.find((t) => t.team === "media")!
    expect(media).toMatchObject({ reviews: 2, reviewed: 1, averageScore: 3, scoreCounts: [0, 1, 0, 1, 0], oldestUnreviewedAt: day(8) })
  })

  it("ranks reviewers by how many reviews they wrote", () => {
    expect(summary.reviewers.map((r) => [r.reviewerId, r.reviews])).toEqual([
      ["gray", 2],
      ["alex", 1],
    ])
  })
})

describe("loadPipelineRows", () => {
  const dbRow = {
    id: "t1",
    track: "media",
    status: "SUBMITTED",
    decidedAt: null,
    application: { id: "a1", userId: "u1", fullName: "Sam", gradYear: 2028, major: "RTF", submittedAt: day(9), autoSubmitted: false, eid: "sk12345", user: { email: "sam@utexas.edu", roles: [{ role: { key: "officer" } }] } },
    reviews: [],
  }

  it("reads submitted applications only, and selects emails and EIDs only when asked", async () => {
    db.applicationTrack.findMany.mockResolvedValue([dbRow])
    const [plain] = await loadPipelineRows("cycle-1")
    const args = db.applicationTrack.findMany.mock.calls[0][0]
    expect(args.where).toEqual({ application: { cycleId: "cycle-1", state: "SUBMITTED" } })
    expect(args.select.application.select.eid).toBe(false)
    expect(args.select.application.select.user.select.email).toBe(false)
    expect(plain.application).not.toHaveProperty("email")
    expect(plain.application).not.toHaveProperty("eid")
    expect(plain.application.officer).toBe(true)

    const [withContact] = await loadPipelineRows("cycle-1", { contact: true })
    expect(db.applicationTrack.findMany.mock.calls[1][0].select.application.select.eid).toBe(true)
    expect(withContact.application).toMatchObject({ email: "sam@utexas.edu", eid: "sk12345" })
  })
})

describe("getPipelinePanel", () => {
  it("counts every applicant for the admin page, without the viewer's own reviews, with reviewer names", async () => {
    const application = (id: string, userId: string, submittedAt: Date) => ({ id, userId, fullName: id, gradYear: null, major: null, submittedAt, autoSubmitted: false, user: { roles: [] } })
    db.applicationTrack.findMany.mockResolvedValue([
      // The viewer's own application, reviewed by Gray: neither its review nor "unreviewed" shows
      { id: "t1", track: "media", status: "IN_REVIEW", decidedAt: null, application: { ...application("a1", "me", day(5)), user: { roles: [{ role: { key: "officer" } }] } }, reviews: [review("gray", 5)] },
      { id: "t2", track: "media", status: "SUBMITTED", decidedAt: null, application: application("a2", "u2", day(6)), reviews: [review("alex", 3)] },
      { id: "t3", track: "media", status: "SUBMITTED", decidedAt: null, application: application("a3", "u3", day(8)), reviews: [] },
    ])
    const panel = await getPipelinePanel("cycle-1", "me", day(20))
    expect(panel).toMatchObject({ total: 3, unreviewed: 1, averageScore: 3, ownApplication: true, reviewers: [{ name: "Alex", reviews: 1 }] })
    expect(panel.byStatus).toMatchObject({ SUBMITTED: 2, IN_REVIEW: 1 })
    // The longest wait is a3's 12 days: the viewer's own (15 days) isn't counted
    expect(panel.teams.find((t) => t.team === "media")).toMatchObject({ total: 3, unreviewed: 1, longestWaitDays: 12 })
  })
})
