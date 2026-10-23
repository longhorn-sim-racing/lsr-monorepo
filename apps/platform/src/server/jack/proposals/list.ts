import type { Prisma } from "@prisma/client"
import type { JackProposalResult, JackProposalStatusKey } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { FORMER_OFFICER } from "../messages"
import { PROPOSAL_KINDS } from "./registry"

/**
 * Every proposal for the Proposals page (/admin/jack/proposals): open ones (pending or applying) first,
 * then the rest, newest first, filtered by status and kind. A pending proposal past its expiry counts
 * as stale here, as it does everywhere it's read.
 */

export const PROPOSALS_PAGE_SIZE = 50

export type ProposalListFilters = { status: JackProposalStatusKey | null; kind: string | null; page: number }

export type ProposalListItem = {
  id: string
  roomId: string
  roomTitle: string | null
  /** Its room is archived: a pending one can't be applied or discarded until an officer unarchives the room */
  roomArchived: boolean
  messageId: string | null
  kind: string
  title: string
  summary: string
  status: JackProposalStatusKey
  /** The outcome or the reason (applied, failed, stale, discarded) */
  result: string | null
  createdAt: Date
  decidedAt: Date | null
  proposedFor: string | null
  decidedBy: string | null
}

export type ProposalList = {
  items: ProposalListItem[]
  total: number
  pageCount: number
  /** Per status over every proposal (not just the filtered ones), stale including the expired pending ones */
  counts: Record<JackProposalStatusKey, number>
  /** Kinds to filter by: the ones the site knows plus any older ones still in the table */
  kinds: string[]
}

function statusWhere(status: JackProposalStatusKey | null, now: Date): Prisma.JackProposalWhereInput {
  if (status === "PENDING") return { status: "PENDING", expiresAt: { gt: now } }
  if (status === "STALE") return { OR: [{ status: "STALE" }, { status: "PENDING", expiresAt: { lte: now } }] }
  return status ? { status } : {}
}

export async function listProposals({ status, kind, page }: ProposalListFilters, now = new Date()): Promise<ProposalList> {
  const filters: Prisma.JackProposalWhereInput = { AND: [statusWhere(status, now), kind ? { kind } : {}] }
  const open: Prisma.JackProposalWhereInput = { OR: [{ status: "APPLYING" }, { status: "PENDING", expiresAt: { gt: now } }] }
  const select = {
    id: true,
    roomId: true,
    messageId: true,
    kind: true,
    title: true,
    summary: true,
    status: true,
    result: true,
    createdAt: true,
    decidedAt: true,
    expiresAt: true,
    proposedForId: true,
    decidedById: true,
    room: { select: { title: true, archivedAt: true } },
  } satisfies Prisma.JackProposalSelect

  const [total, grouped, expired, kindRows] = await Promise.all([
    prisma.jackProposal.count({ where: filters }),
    prisma.jackProposal.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.jackProposal.count({ where: { status: "PENDING", expiresAt: { lte: now } } }),
    prisma.jackProposal.groupBy({ by: ["kind"], _count: { _all: true } }),
  ])
  const pageCount = Math.max(1, Math.ceil(total / PROPOSALS_PAGE_SIZE))
  const current = Math.min(Math.max(1, page), pageCount)
  const start = (current - 1) * PROPOSALS_PAGE_SIZE

  // Open proposals first: take this page's share of them, then fill it from the rest
  const openWhere: Prisma.JackProposalWhereInput = { AND: [filters, open] }
  const openCount = await prisma.jackProposal.count({ where: openWhere })
  const openRows = start < openCount ? await prisma.jackProposal.findMany({ where: openWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: start, take: PROPOSALS_PAGE_SIZE, select }) : []
  const left = PROPOSALS_PAGE_SIZE - openRows.length
  const restRows = left > 0 ? await prisma.jackProposal.findMany({ where: { AND: [filters, { NOT: open }] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: Math.max(0, start - openCount), take: left, select }) : []
  const rows = [...openRows, ...restRows]

  const userIds = [...new Set(rows.flatMap((row) => [row.proposedForId, row.decidedById]).filter((id): id is string => Boolean(id)))]
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }) : []
  const names = new Map(users.map((user) => [user.id, user.displayName]))
  const name = (id: string | null) => (id ? (names.get(id) ?? FORMER_OFFICER) : null)

  const counts = { PENDING: 0, APPLYING: 0, APPLIED: 0, DISCARDED: 0, FAILED: 0, STALE: 0, SUPERSEDED: 0 } satisfies Record<JackProposalStatusKey, number>
  for (const group of grouped) counts[group.status] = group._count._all
  counts.PENDING -= expired
  counts.STALE += expired

  return {
    items: rows.map((row) => {
      const isExpired = row.status === "PENDING" && row.expiresAt <= now
      const result = row.result && typeof row.result === "object" && !Array.isArray(row.result) ? (row.result as unknown as JackProposalResult).summary : null
      return {
        id: row.id,
        roomId: row.roomId,
        roomTitle: row.room.title,
        roomArchived: row.room.archivedAt !== null,
        messageId: row.messageId,
        kind: row.kind,
        title: row.title,
        summary: row.summary,
        status: isExpired ? "STALE" : row.status,
        result: isExpired ? "Nobody applied it within 14 days." : typeof result === "string" ? result : null,
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        proposedFor: name(row.proposedForId),
        decidedBy: name(row.decidedById),
      }
    }),
    total,
    pageCount,
    counts,
    kinds: [...new Set([...PROPOSAL_KINDS.map((k) => k.kind), ...kindRows.map((row) => row.kind)])].sort(),
  }
}
