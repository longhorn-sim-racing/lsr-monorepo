import type { SponsorProspect } from "@prisma/client"
import { z } from "zod"
import { ACTIVITY_LABEL, ACTIVITY_TYPES, PROSPECT_STAGE_LABEL, PROSPECT_STAGES, prospectPath, SPONSORS_PAGE, type ActivityType } from "@/lib/sponsor-prospects"
import { PROSPECT_FIELD_LABEL, PROSPECT_LIMITS, prospectChangesSchema, type ProspectChanges, type ProspectFieldKey } from "@/schemas/sponsor-prospect.schema"
import { prisma } from "@/server/db"
import { logProspectActivityTx, prospectPaths, prospectValue } from "@/server/services/sponsor.service"
import { centralDate, centralDateInput, startOfCentralDay } from "../../tools/time"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalDiffRow, ProposalKind, ProposalLink, ProposalRow } from "../types"
import { cardDay, clip, happenedAt, idInput, listNames, plural, revalidateQuietly } from "./shared"

/**
 * prospect.activity (design §4.3, sponsors-meetings): log what happened with sponsor prospects (an
 * email sent, a reply, a call, a meeting, a note), one or many at once, each a row on the card. An entry
 * can also move its prospect's stage and next step. One that looks already logged (same prospect, type,
 * day and text) is marked ambiguous and starts unpicked. Picked rows apply all or none, through the same
 * service as the Sponsors page; a prospect whose stage or next step moved on since makes it stale.
 */

const activityInput = z.object({
  prospectId: idInput.describe("The prospect's id from sponsors_list"),
  type: z.enum(ACTIVITY_TYPES),
  summary: z.string().trim().min(1).max(PROSPECT_LIMITS.activityMax).describe("What happened, in a sentence or two"),
  date: centralDateInput.optional().describe("Central date it happened, YYYY-MM-DD (default today)"),
  stage: z.enum(PROSPECT_STAGES).optional().describe("Also move the prospect to this stage"),
  nextStep: z.string().trim().max(PROSPECT_LIMITS.nextStepMax).nullable().optional().describe("Also set its next step (null clears it)"),
  nextStepDue: centralDateInput.nullable().optional(),
})

export const prospectActivitySchema = z.object({
  activities: z.array(activityInput).min(1).max(25).describe("One entry per thing that happened"),
})

export type ProspectActivityProposal = z.infer<typeof prospectActivitySchema>
type ActivityRow = z.infer<typeof activityInput>

const rowBefore = z.object({
  prospectId: z.string(),
  company: z.string(),
  /** The instant it's logged at, fixed when proposed ("today" means the moment it was proposed) */
  occurredAt: z.string(),
  /** The stage and next-step fields it changes, as they were */
  fields: z.record(z.string(), z.string().nullable()),
})
const activityBefore = z.object({ rows: z.record(z.string(), rowBefore) })

const rowId = (i: number) => `a${i + 1}`

/** "a meeting with", "an email to": for titles */
const PHRASE: Record<ActivityType, string> = { email_sent: "an email to", reply: "a reply from", meeting: "a meeting with", call: "a call with", note: "a note on" }

type RowChanges = Pick<ProspectChanges, "stage" | "nextStep" | "nextStepDue">

/** The stage and next-step changes a row makes, checked like the Sponsors page checks them */
function rowChanges(row: ActivityRow, label: string): RowChanges {
  const parsed = prospectChangesSchema.pick({ stage: true, nextStep: true, nextStepDue: true }).safeParse({
    stage: row.stage,
    nextStep: row.nextStep,
    nextStepDue: row.nextStepDue === undefined ? undefined : row.nextStepDue === null ? null : startOfCentralDay(row.nextStepDue),
  })
  if (!parsed.success) throw new ProposalInputError(`${label}: ${parsed.error.issues[0]?.message ?? "check it"}`)
  const changes: RowChanges = {}
  if (parsed.data.stage !== undefined) changes.stage = parsed.data.stage
  if (parsed.data.nextStep !== undefined) changes.nextStep = parsed.data.nextStep
  if (parsed.data.nextStepDue !== undefined) changes.nextStepDue = parsed.data.nextStepDue
  return changes
}

/** The fields a row would change on its prospect */
function changedKeys(prospect: SponsorProspect, changes: RowChanges): (keyof RowChanges)[] {
  return (Object.keys(changes) as (keyof RowChanges)[]).filter((key) => prospectValue(changes[key]) !== prospectValue(prospect[key]))
}

function showValue(key: ProspectFieldKey, value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (key === "stage") return PROSPECT_STAGE_LABEL[value as keyof typeof PROSPECT_STAGE_LABEL] ?? String(value)
  if (key === "nextStepDue") return cardDay(value as Date)
  return String(value)
}

export const prospectActivityKind: ProposalKind<ProspectActivityProposal> = {
  kind: "prospect.activity",
  tool: "propose_meeting",
  description:
    "prospect.activity: log emails, replies, calls, meetings or notes on sponsor prospects (by prospectId from sponsors_list), several at once; each can also move its prospect's stage or next step.",
  schema: prospectActivitySchema,
  targetType: "SPONSOR_PROSPECT",
  permission: "officer",

  async prepare(p) {
    const now = new Date()
    const ids = [...new Set(p.activities.map((row) => row.prospectId))]
    const prospects = await prisma.sponsorProspect.findMany({ where: { id: { in: ids } } })
    const byId = new Map(prospects.map((row) => [row.id, row]))
    const missing = ids.filter((id) => !byId.has(id))
    if (missing.length) throw new ProposalInputError(`There's no prospect with id ${missing.join(", ")}. Get ids from sponsors_list.`)
    // Two rows changing the same prospect's stage or next step would race each other
    const changers = p.activities.filter((row) => row.stage !== undefined || row.nextStep !== undefined || row.nextStepDue !== undefined).map((row) => row.prospectId)
    if (new Set(changers).size !== changers.length) throw new ProposalInputError("Change a prospect's stage or next step in one of its entries only.")

    const recent = await prisma.sponsorActivity.findMany({
      where: { prospectId: { in: ids }, occurredAt: { gte: new Date(now.getTime() - 120 * 86_400_000) } },
      select: { prospectId: true, type: true, summary: true, occurredAt: true },
    })

    const rows: ProposalRow[] = []
    const diff: ProposalDiffRow[] = []
    const before: z.infer<typeof activityBefore> = { rows: {} }
    for (const [i, row] of p.activities.entries()) {
      const prospect = byId.get(row.prospectId)!
      const label = `Activity ${i + 1} (${prospect.company})`
      const occurredAt = happenedAt(row.date, now)
      const changes = rowChanges(row, label)
      const keys = changedKeys(prospect, changes)
      const day = centralDate(occurredAt)
      const logged = recent.find((a) => a.prospectId === prospect.id && a.type === row.type && centralDate(a.occurredAt) === day && a.summary.trim().toLowerCase() === row.summary.trim().toLowerCase())
      const moves = keys.map((key) => `${PROSPECT_FIELD_LABEL[key]}: ${clip(showValue(key, prospect[key]) ?? "none", 50)} → ${clip(showValue(key, changes[key]) ?? "none", 50)}`)
      rows.push({
        id: rowId(i),
        label: `${prospect.company}: ${ACTIVITY_LABEL[row.type]}, ${cardDay(occurredAt)}`,
        detail: [logged ? "Looks already logged." : null, clip(row.summary, 200), ...moves].filter(Boolean).join(" · "),
        ...(logged ? { status: "ambiguous" as const } : {}),
      })
      for (const key of keys) {
        diff.push({ field: `${rowId(i)}.${key}`, label: `${prospect.company}: ${PROSPECT_FIELD_LABEL[key]}`, before: showValue(key, prospect[key]), after: showValue(key, changes[key]), format: key === "nextStep" ? "text" : "value" })
      }
      before.rows[rowId(i)] = { prospectId: prospect.id, company: prospect.company, occurredAt: occurredAt.toISOString(), fields: Object.fromEntries(keys.map((key) => [key, prospectValue(prospect[key])])) }
    }

    const companies = [...new Set(p.activities.map((row) => byId.get(row.prospectId)!.company))]
    const single = p.activities.length === 1 ? p.activities[0] : null
    const title = single ? `Log ${PHRASE[single.type]} ${byId.get(single.prospectId)!.company}` : `Log ${plural(p.activities.length, "sponsor activity", "sponsor activities")}`
    const links: ProposalLink[] = companies.length === 1 ? [{ title: companies[0], url: prospectPath(ids[0]) }] : [{ title: "Sponsors", url: SPONSORS_PAGE }]
    return {
      before,
      view: {
        title,
        summary: `Applying it adds ${single ? "it" : "each one"} to ${listNames(companies)}'s activity on Sponsors${diff.length ? ", and changes the stage or next step shown below" : ""}.${p.activities.length > 1 ? " Pick which ones to apply." : ""}`,
        diff,
        rows,
        links,
      },
    }
  },

  // The picked rows are checked in apply, so a change to a prospect an officer left out doesn't block the rest
  async checkStale() {
    return null
  },

  async apply(p, ctx) {
    const was = activityBefore.safeParse(ctx.before)
    if (!was.success) throw new StaleProposalError("The proposal's copy of the prospects is missing. Ask Jack to propose it again.")
    const picked = new Set(ctx.selectedRows ?? p.activities.map((_, i) => rowId(i)))
    const actor = { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata }
    // The officer who reported it did it; the one who applies it only approved it
    const byId = ctx.auditMetadata.proposedFor ?? ctx.officer.userId

    const done = await prisma.$transaction(
      async (tx) => {
        const applied: { rowId: string; prospectId: string; company: string }[] = []
        for (const [i, row] of p.activities.entries()) {
          const id = rowId(i)
          const planned = was.data.rows[id]
          if (!picked.has(id) || !planned) continue
          const changes = rowChanges(row, `Activity ${i + 1} (${planned.company})`)
          const result = await logProspectActivityTx(
            tx,
            planned.prospectId,
            { type: row.type, summary: row.summary, occurredAt: new Date(planned.occurredAt) },
            actor,
            { byId, ...changes, expected: planned.fields },
          )
          if (!result.ok) {
            if (result.reason === "changed") throw new StaleProposalError(`${planned.company}'s stage or next step changed since this was proposed.`)
            if (result.reason === "not_found") throw new StaleProposalError(`${planned.company} was deleted since this was proposed.`)
            throw new Error(`Activity ${i + 1} (${planned.company}): ${result.error}`)
          }
          applied.push({ rowId: id, prospectId: planned.prospectId, company: planned.company })
        }
        return applied
      },
      { timeout: 30_000 },
    )

    revalidateQuietly(done.flatMap((row) => prospectPaths(row.prospectId)))
    const companies = [...new Set(done.map((row) => row.company))]
    return {
      summary: `Logged ${plural(done.length, "activity", "activities")} for ${listNames(companies)}.`,
      links: companies.length === 1 ? [{ title: companies[0], url: prospectPath(done[0].prospectId) }] : [{ title: "Sponsors", url: SPONSORS_PAGE }],
      appliedRows: done.map((row) => row.rowId),
      counts: { logged: done.length },
    }
  },
}
