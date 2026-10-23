import { prisma } from "@/server/db"
import { applyPipelineRules, loadPipelineRows, summarizePipeline } from "@/server/queries/recruiting-pipeline"
import type { DigestCheck, DigestCheckResult, DigestItem } from "../types"

/** Digest and Overview "needs attention" checks from the club-data track (design §11.2) */

const DAY_MS = 86_400_000
/** A closed round still counts this long after its deadline, while its last applications get reviewed */
const CLOSED_ROUND_DAYS = 30
/** An application waiting longer than this without a review makes the check a warning */
const WAITING_DAYS = 7

/**
 * Team applications nobody has reviewed or decided yet (isUnreviewed), per team, in the active round and rounds that
 * closed in the last 30 days. Counts and team names only: no applicant's name leaves the console.
 * Applications from officers and admins aren't counted (their reviews are private, design §3.2)
 */
export const unreviewedApplications: DigestCheck = {
  id: "recruiting.unreviewed",
  label: "Unreviewed applications",
  href: "/admin/recruiting",
  order: 60,
  async run({ now }): Promise<DigestCheckResult> {
    const rounds = await prisma.recruitingCycle.findMany({
      where: { OR: [{ isActive: true }, { closesAt: { gte: new Date(now.getTime() - CLOSED_ROUND_DAYS * DAY_MS), lte: now } }], opensAt: { lte: now } },
      orderBy: { opensAt: "desc" },
      select: { id: true, slug: true, name: true },
    })
    const items: (DigestItem & { waiting: number })[] = []
    let count = 0
    let oldest = 0
    for (const round of rounds) {
      const { rows } = applyPipelineRules(await loadPipelineRows(round.id), { hideOfficerApplicants: true, viewerId: null })
      for (const team of summarizePipeline(rows).teams) {
        if (!team.unreviewed) continue
        count += team.unreviewed
        const waiting = team.oldestUnreviewedAt ? Math.floor((now.getTime() - team.oldestUnreviewedAt.getTime()) / DAY_MS) : 0
        oldest = Math.max(oldest, waiting)
        items.push({
          title: `${team.label}: ${team.unreviewed} ${team.unreviewed === 1 ? "application" : "applications"} with no review${rounds.length > 1 ? ` (${round.name})` : ""}`,
          href: `/admin/recruiting?cycle=${encodeURIComponent(round.slug)}&team=${encodeURIComponent(team.team)}`,
          detail: waiting ? `Oldest waiting ${waiting} ${waiting === 1 ? "day" : "days"}` : "Submitted today",
          waiting,
        })
      }
    }
    return {
      count,
      severity: !count ? "info" : oldest > WAITING_DAYS ? "warning" : "info",
      items: items.sort((a, b) => b.waiting - a.waiting).map(({ title, href, detail }) => ({ title, href, detail })),
    }
  },
}

export const CHECKS: DigestCheck[] = [unreviewedApplications]
