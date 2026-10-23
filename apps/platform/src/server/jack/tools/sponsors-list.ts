import { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"
import { weekdayDate as ctDay } from "@/lib/meetings"
import { SPONSORS } from "@/lib/sponsors"
import {
  activityLabel,
  CLOSED_STAGES,
  daysSince,
  PROSPECT_STAGE_LABEL,
  PROSPECT_STAGES,
  prospectPath,
  QUIET_PROSPECT_DAYS,
  SPONSORS_PAGE,
  TIER_LABEL,
  type ProspectStage,
} from "@/lib/sponsor-prospects"
import { getProspectDetail, listProspects, stageCounts, type ProspectRow } from "@/server/queries/sponsor-prospects"
import { cleanHandle } from "@/server/services/officers"
import { prisma } from "@/server/db"
import { forModelWithLists, plural, tableDisplay } from "./display"
import { ct } from "./time"
import type { JackTool } from "./types"

/**
 * sponsors_list (#188, design §7.1): sponsor prospects (companies the club is courting), their stage,
 * owner, last activity and next step, and one prospect's whole timeline. Deferred (tool search). Contact
 * emails only when an officer asked for them. The sponsors shown on the website are listed apart: they're
 * set in the site's code, and the schema doesn't link them to prospects.
 */

const ACTIVITIES_SHOWN = 50

const input = z.object({
  prospectId: z.string().trim().min(1).max(64).optional().describe("One prospect in full: contact, notes and its activity timeline"),
  stages: z.array(z.enum(PROSPECT_STAGES)).min(1).max(7).optional().describe("Only these stages (default: all but declined and dormant)"),
  owner: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe("Only this officer's prospects, by handle. For \"mine\", the asking officer's handle (only when one officer asked in this turn)"),
  quiet: z.boolean().default(false).describe(`Only prospects in contacted or talking with no activity for ${QUIET_PROSPECT_DAYS}+ days`),
  query: z.string().trim().min(1).max(100).optional().describe("Words in the company, contact, next step or notes"),
  contact: z.boolean().default(false).describe("Add contact emails. Only when an officer asked for them"),
  limit: z.number().int().min(1).max(200).default(50),
})

/** A prospect for the model */
function prospectForModel(row: ProspectRow, now: Date, contact: boolean) {
  return {
    id: row.id,
    company: row.company,
    stage: row.stage,
    ...(row.tierInterest ? { tierInterest: TIER_LABEL[row.tierInterest as keyof typeof TIER_LABEL] ?? row.tierInterest } : {}),
    owner: row.owner ? `${row.owner.displayName} (@${row.owner.handle})` : null,
    ...(row.contactName || row.contactRole ? { contact: [row.contactName, row.contactRole].filter(Boolean).join(", ") } : {}),
    ...(contact && row.contactEmail ? { contactEmail: row.contactEmail } : {}),
    ...(row.website ? { website: row.website } : {}),
    lastActivity: row.lastActivity ? { type: row.lastActivity.type, at: ct(row.lastActivity.occurredAt), summary: clip(row.lastActivity.summary, 200) } : null,
    daysSinceLastActivity: daysSince(row.lastTouchAt, now),
    ...(row.quiet ? { quiet: true } : {}),
    ...(row.nextStep ? { nextStep: row.nextStep } : {}),
    ...(row.nextStepDue ? { nextStepDue: ctDay(row.nextStepDue), ...(row.nextStepOverdue ? { nextStepOverdue: true } : {}) } : {}),
    link: prospectPath(row.id),
  }
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Every word somewhere in the prospect's text */
function matches(row: ProspectRow, query: string): boolean {
  const text = [row.company, row.contactName, row.contactRole, row.nextStep, row.notes, row.website].filter(Boolean).join(" ").toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word))
}

export const sponsorsListTool: JackTool<z.infer<typeof input>> = {
  name: "sponsors_list",
  description:
    "Sponsor prospects: companies the club is courting for sponsorship, with stage (idea, researching, contacted, talking, committed, declined, dormant), tier interest, owner, contact, last activity and next step; filter by stage, owner, quiet or words. With prospectId, one prospect's notes and full activity timeline (emails, replies, calls, meetings). Also lists the sponsors shown on the website, which aren't prospects.",
  input,
  deferred: true,
  async run({ prospectId, stages, owner, quiet, query, contact, limit }) {
    const now = new Date()
    if (prospectId) {
      const detail = await getProspectDetail(prospectId, now)
      if (!detail) return { isError: true, forModel: `There's no prospect with id ${prospectId}. Call sponsors_list without prospectId to list them.`, label: "Prospect not found", displays: [] }
      const activities = detail.activities.slice(0, ACTIVITIES_SHOWN).map((a) => ({ at: ct(a.occurredAt), type: a.type, summary: a.summary, by: a.by ? a.by.displayName : a.byId ? "Former officer" : null }))
      const result = {
        prospect: { ...prospectForModel(detail, now, contact), ...(detail.notes ? { notes: detail.notes } : {}), added: ct(detail.createdAt), ...(detail.lastContactAt ? { lastContact: ct(detail.lastContactAt) } : {}) },
        activityCount: detail.activities.length,
      }
      const displays: JackToolDisplay[] = [
        { kind: "links", items: [{ title: detail.company, url: prospectPath(detail.id), meta: `${PROSPECT_STAGE_LABEL[detail.stage as ProspectStage] ?? detail.stage}${detail.owner ? ` · ${detail.owner.displayName}` : ""}` }] },
        detail.activities.length
          ? tableDisplay(
              detail.activities.slice(0, ACTIVITIES_SHOWN),
              [
                { header: "When", value: (a) => ctDay(a.occurredAt) },
                { header: "What", value: (a) => activityLabel(a.type) },
                { header: "Summary", value: (a) => a.summary },
              ],
              "Activity",
            )
          : { kind: "note", text: "No activity logged yet." },
      ]
      return {
        forModel: forModelWithLists(result, [{ key: "activities", items: activities, whenTrimmed: "The newest come first." }]),
        label: `Looked at ${detail.company} (${plural(detail.activities.length, "activity", "activities")})`,
        displays,
      }
    }

    let ownerId: string | null = null
    if (owner) {
      const user = await prisma.user.findUnique({ where: { handle: cleanHandle(owner) }, select: { id: true } })
      if (!user) return { isError: true, forModel: `No one has the handle @${cleanHandle(owner)}. Get officers' handles from club_members.`, label: "Prospect lookup failed", displays: [] }
      ownerId = user.id
    }

    const all = await listProspects(now)
    const wanted = new Set<string>(stages ?? PROSPECT_STAGES.filter((stage) => !CLOSED_STAGES.includes(stage)))
    const matching = all
      .filter((row) => wanted.has(row.stage) && (!ownerId || row.owner?.id === ownerId) && (!quiet || row.quiet) && (!query || matches(row, query)))
      .sort((a, b) => PROSPECT_STAGES.indexOf(b.stage as ProspectStage) - PROSPECT_STAGES.indexOf(a.stage as ProspectStage) || b.lastTouchAt.getTime() - a.lastTouchAt.getTime())
    const listed = matching.slice(0, limit)
    const counts = stageCounts(all)

    const result = {
      byStage: counts,
      total: all.length,
      quiet: all.filter((row) => row.quiet).length,
      nextStepsOverdue: all.filter((row) => row.nextStepOverdue).length,
      matching: matching.length,
      filters: { stages: [...wanted], owner: owner ? `@${cleanHandle(owner)}` : null, quiet, query: query ?? null },
      definitions: `Quiet: in contacted or talking, with nothing logged for ${QUIET_PROSPECT_DAYS} days or more. Days since last activity count from the newest activity, else the last contact, else when it was added.`,
      onTheWebsite: {
        note: "Sponsors shown on the club website now. They're set in the site's code, not prospects.",
        sponsors: SPONSORS.map((s) => ({ name: s.name, tier: s.tier })),
      },
      page: SPONSORS_PAGE,
    }

    const displays: JackToolDisplay[] = [
      {
        kind: "stats",
        items: [
          { label: "Being worked on", value: counts.idea + counts.researching + counts.contacted + counts.talking, hint: `${counts.talking} talking` },
          { label: "Committed", value: counts.committed },
          { label: "Quiet", value: result.quiet, hint: `No activity in ${QUIET_PROSPECT_DAYS}+ days` },
          { label: "Next steps overdue", value: result.nextStepsOverdue },
        ],
      },
      listed.length
        ? tableDisplay(
            listed,
            [
              { header: "Company", value: (row) => row.company },
              { header: "Stage", value: (row) => PROSPECT_STAGE_LABEL[row.stage as ProspectStage] ?? row.stage },
              { header: "Owner", value: (row) => row.owner?.displayName ?? null },
              { header: "Last activity", value: (row) => (row.lastActivity ? `${activityLabel(row.lastActivity.type)}, ${ctDay(row.lastActivity.occurredAt)}` : null) },
              { header: "Next step", value: (row) => row.nextStep },
            ],
            matching.length > listed.length ? `${listed.length} of ${matching.length}` : undefined,
          )
        : { kind: "note", text: "No prospects match." },
    ]

    return {
      forModel: forModelWithLists(result, [{ key: "prospects", items: listed.map((row) => prospectForModel(row, now, contact)), whenTrimmed: "Filter by stage or owner, or lower the limit." }]),
      label: `Looked at sponsor prospects (${plural(matching.length, "match", "matches")})`,
      displays,
    }
  },
}
