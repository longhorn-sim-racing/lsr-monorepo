import type { KnowledgeSource, Prisma } from "@prisma/client"
import { KNOWLEDGE_STALE_DAYS, parseProvenance } from "@/lib/jack/knowledge"
import { prisma } from "@/server/db"

/**
 * Reads for the Knowledge page and the digest checks (#188, design §9). The views:
 * - active: every entry that isn't archived;
 * - unreviewed: Jack saved or changed it and no officer has reviewed it since (reviewedAt is cleared
 *   on Jack's changes, so: no reviewedAt and a version from Jack);
 * - stale: older than KNOWLEDGE_STALE_DAYS, counted from reviewedAt ?? sourceDate ?? updatedAt;
 * - archived.
 */

export const KNOWLEDGE_VIEWS = ["active", "unreviewed", "stale", "archived"] as const
export type KnowledgeView = (typeof KNOWLEDGE_VIEWS)[number]

export function isKnowledgeView(value: unknown): value is KnowledgeView {
  return KNOWLEDGE_VIEWS.includes(value as KnowledgeView)
}

export const KNOWLEDGE_PAGE_SIZE = 50

export function knowledgeWhere(view: KnowledgeView, now: Date = new Date()): Prisma.KnowledgeEntryWhereInput {
  if (view === "archived") return { archivedAt: { not: null } }
  if (view === "unreviewed") return { archivedAt: null, reviewedAt: null, versions: { some: { via: "jack" } } }
  if (view === "stale") {
    const cutoff = new Date(now.getTime() - KNOWLEDGE_STALE_DAYS * 86_400_000)
    return {
      archivedAt: null,
      OR: [{ reviewedAt: { lt: cutoff } }, { reviewedAt: null, sourceDate: { lt: cutoff } }, { reviewedAt: null, sourceDate: null, updatedAt: { lt: cutoff } }],
    }
  }
  return { archivedAt: null }
}

/** How many entries each view holds, for the filter's counts */
export async function countKnowledgeViews(now: Date = new Date()): Promise<Record<KnowledgeView, number>> {
  const counts = await Promise.all(KNOWLEDGE_VIEWS.map((view) => prisma.knowledgeEntry.count({ where: knowledgeWhere(view, now) })))
  return Object.fromEntries(KNOWLEDGE_VIEWS.map((view, i) => [view, counts[i]])) as Record<KnowledgeView, number>
}

/** Most search matches ranked before the view's filter applies */
const SEARCH_LIMIT = 500

/**
 * Entry ids matching a search, best first: full-text over the title, tags and body (the search index),
 * plus a plain match on the title or a tag, so a half-typed word still finds its entry
 */
export async function searchKnowledgeIds(query: string): Promise<string[]> {
  const q = query.trim().slice(0, 200)
  if (!q) return []
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT e.id
    FROM "KnowledgeEntry" e
    LEFT JOIN "JackSearchDoc" d ON d.source = 'knowledge' AND d."sourceId" = e.id
    CROSS JOIN websearch_to_tsquery('english'::regconfig, ${q}::text) AS query
    WHERE d.search @@ query
       OR strpos(lower(e.title), lower(${q}::text)) > 0
       OR lower(${q}::text) = ANY(e.tags)
    ORDER BY ts_rank(d.search, query) DESC NULLS LAST, (strpos(lower(e.title), lower(${q}::text)) > 0) DESC, e."updatedAt" DESC
    LIMIT ${SEARCH_LIMIT}
  `
  return rows.map((row) => row.id)
}

const listSelect = {
  id: true,
  title: true,
  tags: true,
  sourceType: true,
  sourceDate: true,
  reviewedAt: true,
  archivedAt: true,
  updatedAt: true,
  owner: { select: { displayName: true, handle: true } },
  versions: { where: { via: "jack" }, select: { id: true }, take: 1 },
} satisfies Prisma.KnowledgeEntrySelect

export type KnowledgeListRow = {
  id: string
  title: string
  tags: string[]
  sourceType: KnowledgeSource
  sourceDate: Date | null
  reviewedAt: Date | null
  archivedAt: Date | null
  updatedAt: Date
  owner: { displayName: string; handle: string } | null
  /** Jack saved or changed it and no officer has reviewed it since */
  unreviewed: boolean
}

export type KnowledgeList = { rows: KnowledgeListRow[]; total: number; page: number; pageCount: number; counts: Record<KnowledgeView, number> }

/** One page of a view, newest change first, or best match first when searching */
export async function listKnowledgeEntries({
  q = "",
  view = "active",
  page = 1,
  now = new Date(),
}: { q?: string; view?: KnowledgeView; page?: number; now?: Date } = {}): Promise<KnowledgeList> {
  const where = knowledgeWhere(view, now)
  const counts = await countKnowledgeViews(now)
  const toRow = (row: Prisma.KnowledgeEntryGetPayload<{ select: typeof listSelect }>): KnowledgeListRow => {
    const { versions, ...rest } = row
    return { ...rest, unreviewed: !row.archivedAt && !row.reviewedAt && versions.length > 0 }
  }

  if (q.trim()) {
    const ids = await searchKnowledgeIds(q)
    const matches = ids.length ? await prisma.knowledgeEntry.findMany({ where: { AND: [where, { id: { in: ids } }] }, select: listSelect }) : []
    const rank = new Map(ids.map((id, i) => [id, i]))
    const ordered = matches.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    const pageCount = Math.max(1, Math.ceil(ordered.length / KNOWLEDGE_PAGE_SIZE))
    const current = Math.min(page, pageCount)
    return {
      rows: ordered.slice((current - 1) * KNOWLEDGE_PAGE_SIZE, current * KNOWLEDGE_PAGE_SIZE).map(toRow),
      total: ordered.length,
      page: current,
      pageCount,
      counts,
    }
  }

  const total = counts[view]
  const pageCount = Math.max(1, Math.ceil(total / KNOWLEDGE_PAGE_SIZE))
  const current = Math.min(page, pageCount)
  const rows = await prisma.knowledgeEntry.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    skip: (current - 1) * KNOWLEDGE_PAGE_SIZE,
    take: KNOWLEDGE_PAGE_SIZE,
    select: listSelect,
  })
  return { rows: rows.map(toRow), total, page: current, pageCount, counts }
}

/** A person named on an entry or a version; null name = the account is gone ("Former officer") */
export type KnowledgePerson = { id: string; name: string | null; handle: string | null }

export type KnowledgeVersionRow = { id: string; title: string; body: string; tags: string[]; via: string; roomId: string | null; createdAt: Date; editedBy: KnowledgePerson | null }

/** An entry with its whole history (newest first) and the names behind its plain user ids */
export async function getKnowledgeEntryDetail(id: string) {
  const entry = await prisma.knowledgeEntry.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, displayName: true, handle: true } },
      versions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
    },
  })
  if (!entry) return null

  const provenance = parseProvenance(entry.provenance)
  const userIds = [entry.createdById, entry.updatedById, entry.reviewedById, provenance?.askedBy.userId, ...entry.versions.map((v) => v.editedById)].filter((v): v is string => !!v)
  const roomIds = entry.versions.map((v) => v.roomId).filter((v): v is string => !!v)
  const [users, rooms] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: [...new Set(userIds)] } }, select: { id: true, displayName: true, handle: true } }) : [],
    roomIds.length ? prisma.jackRoom.findMany({ where: { id: { in: [...new Set(roomIds)] } }, select: { id: true, title: true } }) : [],
  ])
  const byId = new Map(users.map((u) => [u.id, u]))
  const person = (userId: string | null): KnowledgePerson | null => {
    if (!userId) return null
    const user = byId.get(userId)
    return { id: userId, name: user?.displayName ?? null, handle: user?.handle ?? null }
  }

  const { versions, ...rest } = entry
  return {
    entry: rest,
    /** Where Jack's latest save or change came from; its asker is `askedBy` */
    provenance,
    createdBy: person(entry.createdById),
    updatedBy: person(entry.updatedById),
    reviewedBy: person(entry.reviewedById),
    /** The officer whose message led to Jack's latest save or change (null: a script, or a proposal with no asker) */
    askedBy: person(provenance?.askedBy.userId ?? null),
    versions: versions.map((v): KnowledgeVersionRow => ({ id: v.id, title: v.title, body: v.body, tags: v.tags, via: v.via, roomId: v.roomId, createdAt: v.createdAt, editedBy: person(v.editedById) })),
    latestVersionId: versions[0]?.id ?? null,
    unreviewed: !entry.archivedAt && !entry.reviewedAt && versions.some((v) => v.via === "jack"),
    roomTitles: Object.fromEntries(rooms.map((r) => [r.id, r.title])) as Record<string, string | null>,
  }
}

export type KnowledgeEntryDetail = NonNullable<Awaited<ReturnType<typeof getKnowledgeEntryDetail>>>

/** Officers and admins, for the owner picker */
export async function listKnowledgeOwners(): Promise<{ id: string; displayName: string; handle: string }[]> {
  return prisma.user.findMany({
    where: { status: { not: "deleted" }, roles: { some: { role: { key: { in: ["officer", "admin"] } } } } },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true, handle: true },
  })
}
