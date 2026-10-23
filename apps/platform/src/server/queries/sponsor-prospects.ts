import { isNextStepOverdue, isQuietProspect, lastTouch, OPEN_STAGES, type ProspectStage } from "@/lib/sponsor-prospects"
import { prisma } from "@/server/db"
import { userNames, type OfficerRef } from "@/server/services/officers"

/**
 * Reads for sponsor prospects (#188): the Sponsors page, Jack's sponsors_list and the digest's quiet
 * check. Prospects are few (dozens), so lists load them all and filter in memory.
 */

/** Most prospects a list loads */
const MAX_PROSPECTS = 1_000

export type ProspectRow = {
  id: string
  company: string
  website: string | null
  contactName: string | null
  contactEmail: string | null
  contactRole: string | null
  stage: string
  tierInterest: string | null
  owner: OfficerRef | null
  nextStep: string | null
  nextStepDue: Date | null
  notes: string | null
  lastContactAt: Date | null
  createdAt: Date
  updatedAt: Date
  /** The newest activity (any type) */
  lastActivity: { type: string; occurredAt: Date; summary: string } | null
  /** lastTouch(): the newest activity, else the last contact, else when it was added */
  lastTouchAt: Date
  quiet: boolean
  nextStepOverdue: boolean
}

export async function listProspects(now = new Date()): Promise<ProspectRow[]> {
  const rows = await prisma.sponsorProspect.findMany({
    orderBy: [{ updatedAt: "desc" }],
    take: MAX_PROSPECTS,
    include: {
      owner: { select: { id: true, displayName: true, handle: true } },
      activities: { orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], take: 1, select: { type: true, occurredAt: true, summary: true } },
    },
  })
  return rows.map((row) => {
    const lastActivity = row.activities[0] ?? null
    const touch = { createdAt: row.createdAt, lastContactAt: row.lastContactAt, lastActivityAt: lastActivity?.occurredAt ?? null }
    return {
      id: row.id,
      company: row.company,
      website: row.website,
      contactName: row.contactName,
      contactEmail: row.contactEmail,
      contactRole: row.contactRole,
      stage: row.stage,
      tierInterest: row.tierInterest,
      owner: row.owner,
      nextStep: row.nextStep,
      nextStepDue: row.nextStepDue,
      notes: row.notes,
      lastContactAt: row.lastContactAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastActivity,
      lastTouchAt: lastTouch(touch),
      quiet: isQuietProspect({ stage: row.stage, ...touch }, now),
      nextStepOverdue: isNextStepOverdue(row, now),
    }
  })
}

export type ProspectView = "active" | "committed" | "closed" | "quiet" | "all"

export const PROSPECT_VIEWS: ProspectView[] = ["active", "committed", "closed", "quiet", "all"]

export function isProspectView(value: unknown): value is ProspectView {
  return typeof value === "string" && (PROSPECT_VIEWS as string[]).includes(value)
}

/** Whether a prospect belongs in a view of the Sponsors page */
export function inProspectView(row: Pick<ProspectRow, "stage" | "quiet">, view: ProspectView): boolean {
  switch (view) {
    case "active":
      return (OPEN_STAGES as readonly string[]).includes(row.stage)
    case "committed":
      return row.stage === "committed"
    case "closed":
      return row.stage === "declined" || row.stage === "dormant"
    case "quiet":
      return row.quiet
    default:
      return true
  }
}

/** Counts per stage, every stage present */
export function stageCounts(rows: Pick<ProspectRow, "stage">[]): Record<ProspectStage, number> {
  const counts = { idea: 0, researching: 0, contacted: 0, talking: 0, committed: 0, declined: 0, dormant: 0 } satisfies Record<ProspectStage, number>
  for (const row of rows) if (row.stage in counts) counts[row.stage as ProspectStage] += 1
  return counts
}

export type ProspectActivityRow = { id: string; type: string; summary: string; occurredAt: Date; createdAt: Date; by: OfficerRef | null; byId: string | null }

export type ProspectDetail = ProspectRow & { activities: ProspectActivityRow[]; createdBy: OfficerRef | null; createdById: string | null }

export async function getProspectDetail(id: string, now = new Date()): Promise<ProspectDetail | null> {
  const row = await prisma.sponsorProspect.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, displayName: true, handle: true } },
      activities: { orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], take: 500 },
    },
  })
  if (!row) return null
  const names = await userNames([row.createdById, ...row.activities.map((a) => a.byId)])
  const lastActivity = row.activities[0] ? { type: row.activities[0].type, occurredAt: row.activities[0].occurredAt, summary: row.activities[0].summary } : null
  const touch = { createdAt: row.createdAt, lastContactAt: row.lastContactAt, lastActivityAt: lastActivity?.occurredAt ?? null }
  return {
    id: row.id,
    company: row.company,
    website: row.website,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactRole: row.contactRole,
    stage: row.stage,
    tierInterest: row.tierInterest,
    owner: row.owner,
    nextStep: row.nextStep,
    nextStepDue: row.nextStepDue,
    notes: row.notes,
    lastContactAt: row.lastContactAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivity,
    lastTouchAt: lastTouch(touch),
    quiet: isQuietProspect({ stage: row.stage, ...touch }, now),
    nextStepOverdue: isNextStepOverdue(row, now),
    createdById: row.createdById,
    createdBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
    activities: row.activities.map((a) => ({ id: a.id, type: a.type, summary: a.summary, occurredAt: a.occurredAt, createdAt: a.createdAt, byId: a.byId, by: a.byId ? (names.get(a.byId) ?? null) : null })),
  }
}
