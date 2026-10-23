import type { TrackStatus } from "@prisma/client"
import { prisma } from "@/server/db"
import { tracks } from "@/schemas/recruiting.schema"
import { TRACK_STATUS_ORDER } from "@/lib/recruiting/labels"

/**
 * A recruiting round's pipeline (#188, design §7.1 and §13): team applications by status, which ones
 * nobody has reviewed, who has reviewed how many, and score summaries. Shared by Jack's
 * recruiting_pipeline tool and the summary panel on /admin/recruiting.
 *
 * Only SUBMITTED applications count; drafts are never read. Two rules decide which reviews count:
 * - Jack's (design §3.2, the same as the jack_readonly policies): rooms are shared by every officer,
 *   so applications from anyone who holds the officer or admin role lose their teams, statuses,
 *   reviews and scores entirely. Only that they applied (name, date) is left.
 * - The admin page's: an officer never sees reviews of their own application (viewerId).
 */

export const OFFICER_ROLES = ["officer", "admin"]

/** Statuses that are a decision: a team application in one of these is done */
const DECIDED: TrackStatus[] = ["ACCEPTED", "REJECTED"]

export type PipelineReview = { score: number | null; reviewerId: string | null; createdAt: Date }

/** One team application in a round */
export type PipelineRow = {
  id: string
  track: string
  status: TrackStatus
  decidedAt: Date | null
  application: {
    id: string
    userId: string
    fullName: string | null
    gradYear: number | null
    major: string | null
    submittedAt: Date | null
    autoSubmitted: boolean
    /** Holds the officer or admin role now */
    officer: boolean
    /** Only loaded when asked for (contact: true) */
    email?: string | null
    eid?: string | null
  }
  reviews: PipelineReview[]
}

/**
 * Every submitted team application in a round, with its reviews. Emails and EIDs are only selected
 * when `contact` is true, so they never load otherwise.
 */
export async function loadPipelineRows(cycleId: string, { contact = false }: { contact?: boolean } = {}): Promise<PipelineRow[]> {
  const rows = await prisma.applicationTrack.findMany({
    where: { application: { cycleId, state: "SUBMITTED" } },
    orderBy: [{ application: { submittedAt: "asc" } }, { track: "asc" }, { id: "asc" }],
    select: {
      id: true,
      track: true,
      status: true,
      decidedAt: true,
      application: {
        select: {
          id: true,
          userId: true,
          fullName: true,
          gradYear: true,
          major: true,
          submittedAt: true,
          autoSubmitted: true,
          eid: contact,
          user: { select: { email: contact, roles: { select: { role: { select: { key: true } } } } } },
        },
      },
      reviews: { select: { score: true, reviewerId: true, createdAt: true } },
    },
  })
  return rows.map(({ application: { user, eid, ...application }, ...row }) => ({
    ...row,
    application: {
      ...application,
      officer: user.roles.some((r) => OFFICER_ROLES.includes(r.role.key)),
      ...(contact ? { email: user.email ?? null, eid: eid ?? null } : {}),
    },
  }))
}

export type PipelineRules = {
  /** Jack's rule: leave out everything about applications from officers and admins but that they applied */
  hideOfficerApplicants: boolean
  /** The admin page's rule: this officer's own application shows without its reviews; null for none */
  viewerId: string | null
}

export type HiddenApplicant = { applicationId: string; fullName: string | null; submittedAt: Date | null }

/** The rows the rules let through (reviews of the viewer's own application removed), and the applicants hidden by Jack's rule */
export function applyPipelineRules(rows: PipelineRow[], rules: PipelineRules): { rows: PipelineRow[]; hidden: HiddenApplicant[] } {
  const visible: PipelineRow[] = []
  const hidden = new Map<string, HiddenApplicant>()
  for (const row of rows) {
    if (rules.hideOfficerApplicants && row.application.officer) {
      hidden.set(row.application.id, { applicationId: row.application.id, fullName: row.application.fullName, submittedAt: row.application.submittedAt })
      continue
    }
    visible.push(rules.viewerId && row.application.userId === rules.viewerId ? { ...row, reviews: [] } : row)
  }
  return { rows: visible, hidden: [...hidden.values()] }
}

/** No reviews yet and no decision yet: what "unreviewed" means for the pipeline, the tool and the digest */
export function isUnreviewed(row: Pick<PipelineRow, "status" | "reviews">): boolean {
  return row.reviews.length === 0 && !DECIDED.includes(row.status)
}

export function averageScore(reviews: PipelineReview[]): number | null {
  const scores = reviews.map((r) => r.score).filter((s): s is number => s !== null)
  return scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null
}

export type TeamPipeline = {
  team: string
  label: string
  interviewRequired: boolean
  total: number
  byStatus: Record<TrackStatus, number>
  unreviewed: number
  /** Team applications with at least one review */
  reviewed: number
  reviews: number
  averageScore: number | null
  /** How many reviews gave each score, 1 to 5 */
  scoreCounts: [number, number, number, number, number]
  /** When the longest-waiting unreviewed application was submitted */
  oldestUnreviewedAt: Date | null
}

export type ReviewerLoad = { reviewerId: string | null; reviews: number; teamApplications: number; averageScore: number | null }

export type PipelineSummary = {
  /** Distinct applications (people) and team applications counted */
  applications: number
  teamApplications: number
  unreviewed: number
  averageScore: number | null
  teams: TeamPipeline[]
  reviewers: ReviewerLoad[]
}

function emptyStatuses(): Record<TrackStatus, number> {
  return Object.fromEntries(TRACK_STATUS_ORDER.map((status) => [status, 0])) as Record<TrackStatus, number>
}

/** Counts per team and status, unreviewed, scores and reviewer load, from rows the rules already filtered */
export function summarizePipeline(rows: PipelineRow[]): PipelineSummary {
  const known = new Map<string, { label: string; interviewRequired: boolean }>(tracks.map((t) => [t.key, { label: t.label, interviewRequired: t.interviewRequired }]))
  const teams = new Map<string, TeamPipeline & { allReviews: PipelineReview[] }>()
  const teamOf = (key: string) => {
    let team = teams.get(key)
    if (!team) {
      const info = known.get(key)
      team = {
        team: key,
        label: info?.label ?? key,
        interviewRequired: info?.interviewRequired ?? false,
        total: 0,
        byStatus: emptyStatuses(),
        unreviewed: 0,
        reviewed: 0,
        reviews: 0,
        averageScore: null,
        scoreCounts: [0, 0, 0, 0, 0],
        oldestUnreviewedAt: null,
        allReviews: [],
      }
      teams.set(key, team)
    }
    return team
  }
  // Every known team shows, even with no applications yet
  for (const key of known.keys()) teamOf(key)

  const reviewers = new Map<string | null, { reviews: PipelineReview[]; tracks: Set<string> }>()
  for (const row of rows) {
    const team = teamOf(row.track)
    team.total += 1
    team.byStatus[row.status] += 1
    if (row.reviews.length) team.reviewed += 1
    if (isUnreviewed(row)) {
      team.unreviewed += 1
      const at = row.application.submittedAt
      if (at && (!team.oldestUnreviewedAt || at < team.oldestUnreviewedAt)) team.oldestUnreviewedAt = at
    }
    for (const review of row.reviews) {
      team.reviews += 1
      team.allReviews.push(review)
      if (review.score !== null && review.score >= 1 && review.score <= 5) team.scoreCounts[review.score - 1] += 1
      const load = reviewers.get(review.reviewerId) ?? { reviews: [], tracks: new Set<string>() }
      load.reviews.push(review)
      load.tracks.add(row.id)
      reviewers.set(review.reviewerId, load)
    }
  }

  const order = [...known.keys()]
  const teamList = [...teams.values()]
    .sort((a, b) => (order.indexOf(a.team) + 1 || order.length + 1) - (order.indexOf(b.team) + 1 || order.length + 1) || a.team.localeCompare(b.team))
    .map(({ allReviews, ...team }) => ({ ...team, averageScore: averageScore(allReviews) }))

  return {
    applications: new Set(rows.map((r) => r.application.id)).size,
    teamApplications: rows.length,
    unreviewed: teamList.reduce((n, t) => n + t.unreviewed, 0),
    averageScore: averageScore(rows.flatMap((r) => r.reviews)),
    teams: teamList,
    reviewers: [...reviewers.entries()]
      .map(([reviewerId, load]) => ({ reviewerId, reviews: load.reviews.length, teamApplications: load.tracks.size, averageScore: averageScore(load.reviews) }))
      .sort((a, b) => b.reviews - a.reviews),
  }
}

/** Reviewers' names, by id, for the reviewer load ("Former officer" for a deleted account) */
export async function reviewerNames(ids: (string | null)[]): Promise<Map<string, { displayName: string; handle: string }>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (!wanted.length) return new Map()
  const users = await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true, handle: true } })
  return new Map(users.map((u) => [u.id, { displayName: u.displayName, handle: u.handle }]))
}
