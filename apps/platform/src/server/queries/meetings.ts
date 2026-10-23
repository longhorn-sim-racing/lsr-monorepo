import type { Prisma } from "@prisma/client"
import { isOverdue } from "@/lib/meetings"
import { prisma } from "@/server/db"
import { userNames, type OfficerRef } from "@/server/services/officers"

/**
 * Reads for meetings, decisions and action items (#188): the Meetings and Action items pages, Jack's
 * meetings_list, the digest's overdue check and the Overview card.
 */

export type MeetingListRow = {
  id: string
  title: string
  kind: string
  heldAt: Date
  hasAgenda: boolean
  hasSummary: boolean
  decisions: number
  actionItems: number
  openItems: number
}

export type MeetingFilter = { kind?: string; from?: Date; to?: Date; ids?: string[] }

export async function listMeetings(filter: MeetingFilter = {}, take = 500): Promise<MeetingListRow[]> {
  const where: Prisma.MeetingWhereInput = {
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.from || filter.to ? { heldAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
    ...(filter.ids ? { id: { in: filter.ids } } : {}),
  }
  const rows = await prisma.meeting.findMany({
    where,
    orderBy: { heldAt: "desc" },
    take,
    select: {
      id: true,
      title: true,
      kind: true,
      heldAt: true,
      agendaMd: true,
      summaryMd: true,
      _count: { select: { decisions: true, actionItems: true } },
      actionItems: { where: { status: "open" }, select: { id: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    heldAt: row.heldAt,
    hasAgenda: Boolean(row.agendaMd?.trim()),
    hasSummary: Boolean(row.summaryMd?.trim()),
    decisions: row._count.decisions,
    actionItems: row._count.actionItems,
    openItems: row.actionItems.length,
  }))
}

export type DecisionRow = {
  id: string
  text: string
  decidedAt: Date
  meeting: { id: string; title: string; kind: string } | null
  knowledge: { id: string; title: string; archived: boolean } | null
}

const decisionSelect = {
  id: true,
  text: true,
  decidedAt: true,
  meeting: { select: { id: true, title: true, kind: true } },
  knowledgeEntry: { select: { id: true, title: true, archivedAt: true } },
} satisfies Prisma.MeetingDecisionSelect

function toDecisionRow(row: Prisma.MeetingDecisionGetPayload<{ select: typeof decisionSelect }>): DecisionRow {
  return {
    id: row.id,
    text: row.text,
    decidedAt: row.decidedAt,
    meeting: row.meeting,
    knowledge: row.knowledgeEntry ? { id: row.knowledgeEntry.id, title: row.knowledgeEntry.title, archived: Boolean(row.knowledgeEntry.archivedAt) } : null,
  }
}

/** Decisions, newest first, each with its meeting and decision-log entry */
export async function listDecisions(where: Prisma.MeetingDecisionWhereInput = {}, take = 200): Promise<DecisionRow[]> {
  const rows = await prisma.meetingDecision.findMany({ where, orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }], take, select: decisionSelect })
  return rows.map(toDecisionRow)
}

export type ActionItemRow = {
  id: string
  text: string
  status: string
  dueAt: Date | null
  doneAt: Date | null
  createdAt: Date
  owner: OfficerRef | null
  meeting: { id: string; title: string; heldAt: Date } | null
  overdue: boolean
}

const itemSelect = {
  id: true,
  text: true,
  status: true,
  dueAt: true,
  doneAt: true,
  createdAt: true,
  owner: { select: { id: true, displayName: true, handle: true } },
  meeting: { select: { id: true, title: true, heldAt: true } },
} satisfies Prisma.ActionItemSelect

export type ActionItemFilter = {
  /** "overdue" = open and past due; "all" = every status */
  status?: "open" | "done" | "dropped" | "overdue" | "all"
  /** A user id, or null for items nobody owns */
  ownerId?: string | null
  meetingId?: string
}

/**
 * Action items, overdue first, then by due date (no date last), then newest. Done and dropped items
 * come newest-finished first
 */
export async function listActionItems(filter: ActionItemFilter = {}, now = new Date(), take = 1_000): Promise<ActionItemRow[]> {
  const status = filter.status ?? "open"
  const where: Prisma.ActionItemWhereInput = {
    ...(status === "all" ? {} : { status: status === "overdue" ? "open" : status }),
    ...(filter.ownerId !== undefined ? { ownerId: filter.ownerId } : {}),
    ...(filter.meetingId ? { meetingId: filter.meetingId } : {}),
  }
  const rows = await prisma.actionItem.findMany({ where, orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }], take, select: itemSelect })
  const items = rows.map((row) => ({ ...row, overdue: isOverdue(row, now) }))
  return sortActionItems(status === "overdue" ? items.filter((item) => item.overdue) : items)
}

/** Open items first (overdue first, then by due date), then done and dropped ones, most recently finished first */
export function sortActionItems<T extends { status: string; overdue: boolean; dueAt: Date | null; doneAt: Date | null; createdAt: Date }>(items: T[]): T[] {
  const rank = (item: T) => (item.status === "open" ? (item.overdue ? 0 : 1) : 2)
  return [...items].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (rank(a) === 2) return (b.doneAt ?? b.createdAt).getTime() - (a.doneAt ?? a.createdAt).getTime()
    if (a.dueAt && b.dueAt && a.dueAt.getTime() !== b.dueAt.getTime()) return a.dueAt.getTime() - b.dueAt.getTime()
    if (a.dueAt && !b.dueAt) return -1
    if (!a.dueAt && b.dueAt) return 1
    return b.createdAt.getTime() - a.createdAt.getTime()
  })
}

/** Counts for the Action items page's filters */
export async function actionItemCounts(now = new Date()): Promise<{ open: number; overdue: number; done: number; dropped: number; all: number }> {
  const [grouped, open] = await Promise.all([
    prisma.actionItem.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.actionItem.findMany({ where: { status: "open", dueAt: { not: null } }, select: { status: true, dueAt: true } }),
  ])
  const count = (status: string) => grouped.find((g) => g.status === status)?._count._all ?? 0
  return {
    open: count("open"),
    overdue: open.filter((item) => isOverdue(item, now)).length,
    done: count("done"),
    dropped: count("dropped"),
    all: grouped.reduce((n, g) => n + g._count._all, 0),
  }
}

export type MeetingDetail = {
  meeting: {
    id: string
    title: string
    kind: string
    heldAt: Date
    agendaMd: string | null
    summaryMd: string | null
    createdAt: Date
    updatedAt: Date
  }
  createdBy: OfficerRef | null
  transcript: { id: string; filename: string; roomId: string } | null
  transcriptDocument: { id: string; name: string; webUrl: string } | null
  room: { id: string; title: string | null } | null
  decisions: DecisionRow[]
  actionItems: ActionItemRow[]
}

export async function getMeetingDetail(id: string, now = new Date()): Promise<MeetingDetail | null> {
  const row = await prisma.meeting.findUnique({
    where: { id },
    include: {
      transcriptFile: { select: { id: true, filename: true, roomId: true } },
      transcriptDocument: { select: { id: true, name: true, webUrl: true } },
      room: { select: { id: true, title: true } },
    },
  })
  if (!row) return null
  const [decisions, items, names] = await Promise.all([
    prisma.meetingDecision.findMany({ where: { meetingId: id }, orderBy: [{ createdAt: "asc" }], select: decisionSelect }),
    prisma.actionItem.findMany({ where: { meetingId: id }, orderBy: [{ createdAt: "asc" }], select: itemSelect }),
    userNames([row.createdById]),
  ])
  return {
    meeting: { id: row.id, title: row.title, kind: row.kind, heldAt: row.heldAt, agendaMd: row.agendaMd, summaryMd: row.summaryMd, createdAt: row.createdAt, updatedAt: row.updatedAt },
    createdBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
    transcript: row.transcriptFile,
    transcriptDocument: row.transcriptDocument,
    room: row.room,
    decisions: decisions.map(toDecisionRow),
    actionItems: items.map((item) => ({ ...item, overdue: isOverdue(item, now) })),
  }
}

/** Who owns open items (for the Action items page's owner filter): every officer plus anyone else who still owns one */
export async function actionItemOwners(): Promise<OfficerRef[]> {
  const owners = await prisma.actionItem.findMany({ where: { ownerId: { not: null } }, distinct: ["ownerId"], select: { ownerId: true } })
  const names = await userNames(owners.map((o) => o.ownerId))
  return [...names.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}
