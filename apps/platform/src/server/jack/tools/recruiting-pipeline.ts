import type { TrackStatus } from "@prisma/client"
import { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"
import { TRACK_STATUS_LABEL, TRACK_STATUS_ORDER } from "@/lib/recruiting/labels"
import { tracks } from "@/schemas/recruiting.schema"
import { applyPipelineRules, averageScore, isUnreviewed, loadPipelineRows, reviewerNames, summarizePipeline, type PipelineRow } from "@/server/queries/recruiting-pipeline"
import { listCycles } from "@/server/services/recruiting-cycle.service"
import { forModelWithLists, plural, tableDisplay } from "./display"
import { ct } from "./time"
import type { JackTool } from "./types"

/**
 * recruiting_pipeline (#188, design §7.1): a recruiting round's pipeline. Submitted applications only,
 * and nothing about applications from officers or admins beyond that they applied (the same rule as
 * Jack's SQL role, design §3.2): rooms are shared, so no officer may read reviews of their own
 * application through Jack. Emails and EIDs only when an officer asked for them.
 */

const TEAM_KEYS = tracks.map((t) => t.key) as [string, ...string[]]
const TEAM_LABEL = new Map<string, string>(tracks.map((t) => [t.key, t.label]))
const DAY_MS = 86_400_000

const input = z.object({
  round: z.string().trim().max(60).optional().describe("The round's slug, e.g. fall-2026 (default: the active round, else the latest)"),
  team: z.enum(TEAM_KEYS).optional().describe("Only this team"),
  status: z
    .enum(TRACK_STATUS_ORDER as [TrackStatus, ...TrackStatus[]])
    .optional()
    .describe('Only team applications with this status. SUBMITTED shows on the site as "New", REJECTED as "Not moving forward"; "in interview" is INTERVIEW'),
  unreviewed: z.boolean().default(false).describe("Only team applications nobody has reviewed and nobody has decided yet"),
  applicants: z.boolean().default(false).describe("List the applicants (name, team, status, reviews, average score, a link). A team, status or unreviewed filter lists them too"),
  contact: z.boolean().default(false).describe("Add each applicant's email and EID. Only when an officer asked for them"),
  limit: z.number().int().min(1).max(200).default(50).describe("Most applicants to list"),
})

/** One applicant row for the model */
function applicantRow(row: PipelineRow, now: Date, contact: boolean) {
  const score = averageScore(row.reviews)
  const waiting = isUnreviewed(row) && row.application.submittedAt ? Math.floor((now.getTime() - row.application.submittedAt.getTime()) / DAY_MS) : null
  return {
    name: row.application.fullName ?? "(no name)",
    team: TEAM_LABEL.get(row.track) ?? row.track,
    status: TRACK_STATUS_LABEL[row.status],
    submitted: ct(row.application.submittedAt),
    ...(row.application.autoSubmitted ? { autoSubmitted: true } : {}),
    ...(row.application.gradYear ? { gradYear: row.application.gradYear } : {}),
    ...(row.application.major ? { major: row.application.major } : {}),
    reviews: row.reviews.length,
    ...(score !== null ? { averageScore: score } : {}),
    ...(waiting !== null ? { daysWithoutReview: waiting } : {}),
    ...(row.decidedAt ? { decided: ct(row.decidedAt) } : {}),
    ...(contact ? { email: row.application.email ?? null, eid: row.application.eid ?? null } : {}),
    link: `/admin/recruiting/${row.application.id}`,
  }
}

export const recruitingPipelineTool: JackTool<z.infer<typeof input>> = {
  name: "recruiting_pipeline",
  description:
    "Recruiting (officer applications to the club's teams): the rounds, then for one round the team applications per team and status, how many nobody has reviewed yet, scores (average and 1-5 counts) per team, and reviewer load (reviews per officer). With applicants (or a team, status or unreviewed filter) it lists applicants with their team, status, review count, average score and a link to the application. Submitted applications only. Applications from officers and admins show only that they applied: their teams, reviews and decisions are private.",
  input,
  deferred: true,
  async run({ round, team, status, unreviewed, applicants, contact, limit }) {
    const now = new Date()
    const cycles = await listCycles(now)
    const rounds = cycles.map((c) => ({ round: c.name, slug: c.slug, opens: ct(c.opensAt), closes: ct(c.closesAt), active: c.isActive, window: c.window, submitted: c.submitted }))
    if (!cycles.length) return { forModel: "There are no recruiting rounds yet.", label: "Looked at recruiting (no rounds yet)", displays: [{ kind: "note", text: "No recruiting rounds yet." }] }
    const cycle = round ? cycles.find((c) => c.slug === round) : (cycles.find((c) => c.isActive) ?? cycles[0])
    if (!cycle) return { isError: true, forModel: `No round "${round}". Rounds: ${cycles.map((c) => c.slug).join(", ")}.`, label: "Recruiting lookup failed", displays: [] }

    const { rows, hidden } = applyPipelineRules(await loadPipelineRows(cycle.id, { contact }), { hideOfficerApplicants: true, viewerId: null })
    const summary = summarizePipeline(rows)
    const names = await reviewerNames(summary.reviewers.map((r) => r.reviewerId))

    const listing = applicants || Boolean(team || status || unreviewed)
    const matching = rows.filter((row) => (!team || row.track === team) && (!status || row.status === status) && (!unreviewed || isUnreviewed(row)))
    const listed = listing ? matching.slice(0, limit).map((row) => applicantRow(row, now, contact)) : []

    const teamRows = summary.teams.map((t) => ({
      team: t.label,
      total: t.total,
      ...Object.fromEntries(TRACK_STATUS_ORDER.map((s) => [TRACK_STATUS_LABEL[s], t.byStatus[s]])),
      unreviewed: t.unreviewed,
      ...(t.oldestUnreviewedAt ? { longestWaitDays: Math.floor((now.getTime() - t.oldestUnreviewedAt.getTime()) / DAY_MS) } : {}),
      reviews: t.reviews,
      averageScore: t.averageScore,
      scores1to5: t.scoreCounts,
    }))
    const reviewerRows = summary.reviewers.map((r) => {
      const who = r.reviewerId ? names.get(r.reviewerId) : undefined
      return { reviewer: who ? `${who.displayName} (@${who.handle})` : "Former officer", reviews: r.reviews, teamApplications: r.teamApplications, averageScoreGiven: r.averageScore }
    })

    const result = {
      round: { name: cycle.name, slug: cycle.slug, window: cycle.window, opens: ct(cycle.opensAt), closes: ct(cycle.closesAt), active: cycle.isActive },
      otherRounds: rounds.filter((r) => r.slug !== cycle.slug),
      applications: summary.applications,
      teamApplications: summary.teamApplications,
      unreviewed: summary.unreviewed,
      averageScore: summary.averageScore,
      definitions:
        'Unreviewed = no reviews and no decision yet. Statuses as the site shows them: New (received, not looked at), In review, Interview, Accepted, Not moving forward. Scores are 1 to 5; reviews without a score don\'t count toward averages.',
      ...(hidden.length
        ? { officerApplicants: { count: hidden.length, note: "From current officers or admins: their teams, statuses, reviews and decisions are private and left out of every count here.", applicants: hidden.map((h) => ({ name: h.fullName ?? "(no name)", submitted: ct(h.submittedAt) })) } }
        : {}),
      ...(listing ? { matching: matching.length, filters: { team: team ?? null, status: status ?? null, unreviewed } } : {}),
    }

    const displays: JackToolDisplay[] = [
      {
        kind: "stats",
        items: [
          { label: "Applicants", value: summary.applications, hint: plural(summary.teamApplications, "team application") },
          { label: "Not reviewed yet", value: summary.unreviewed },
          { label: "Interviews", value: summary.teams.reduce((n, t) => n + t.byStatus.INTERVIEW, 0) },
          { label: "Accepted", value: summary.teams.reduce((n, t) => n + t.byStatus.ACCEPTED, 0) },
        ],
      },
      tableDisplay(
        summary.teams,
        [
          { header: "Team", value: (t) => t.label },
          { header: "Applied", value: (t) => t.total },
          ...TRACK_STATUS_ORDER.map((s) => ({ header: TRACK_STATUS_LABEL[s], value: (t: (typeof summary.teams)[number]) => t.byStatus[s] })),
          { header: "Unreviewed", value: (t) => t.unreviewed },
          { header: "Avg score", value: (t) => t.averageScore },
        ],
        cycle.name,
      ),
    ]
    if (listing)
      displays.push(
        listed.length
          ? tableDisplay(
              listed,
              [
                { header: "Applicant", value: (a) => a.name },
                { header: "Team", value: (a) => a.team },
                { header: "Status", value: (a) => a.status },
                { header: "Reviews", value: (a) => a.reviews },
                { header: "Avg score", value: (a) => a.averageScore ?? null },
              ],
              matching.length > listed.length ? `${listed.length} of ${matching.length}` : undefined,
            )
          : { kind: "note", text: "No team applications match." },
      )
    if (hidden.length) displays.push({ kind: "note", text: `${plural(hidden.length, "applicant")} who ${hidden.length === 1 ? "is an officer or admin is" : "are officers or admins are"} left out of the counts.` })

    return {
      forModel: forModelWithLists(result, [
        { key: "teams", items: teamRows },
        { key: "reviewers", items: reviewerRows },
        ...(listing ? [{ key: "applicants", items: listed, whenTrimmed: "Filter by team or status, or lower the limit." }] : []),
      ]),
      label: `Looked at recruiting for ${cycle.name} (${plural(summary.applications, "applicant")}${listing ? `, ${plural(matching.length, "match", "matches")}` : ""})`,
      displays,
    }
  },
}
