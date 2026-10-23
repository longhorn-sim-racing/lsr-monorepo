import type { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"

/**
 * Reads for the Knowledge page's Documents and Teams messages tabs (#188, design §9, §13): the same
 * synced copies Jack searches, so officers can see exactly what Jack can. Officers only (the page checks).
 * Searching uses the search index (JackSearchDoc) plus a plain match on names, folders and authors, so a
 * half-typed word still finds something.
 */

export const DOCUMENTS_PAGE_SIZE = 50
/** Most search matches ranked before paging */
const SEARCH_LIMIT = 500
/** How much of a message the list shows */
export const EXCERPT_CHARS = 280

export type DocumentRow = {
  id: string
  name: string
  path: string
  source: string
  webUrl: string
  mimeType: string
  modifiedAt: Date
  textStatus: string
}

export type DocumentList = { rows: DocumentRow[]; total: number; page: number; pageCount: number; counts: Record<string, number> }

const documentSelect = { id: true, name: true, path: true, source: true, webUrl: true, mimeType: true, modifiedAt: true, textStatus: true } satisfies Prisma.ExternalDocumentSelect

function pageOf<T>(items: T[], page: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / DOCUMENTS_PAGE_SIZE))
  const current = Math.min(Math.max(1, page), pageCount)
  return { rows: items.slice((current - 1) * DOCUMENTS_PAGE_SIZE, current * DOCUMENTS_PAGE_SIZE), page: current, pageCount }
}

/** Document ids matching a search, best first, among these sources */
async function searchDocumentIds(query: string, sources: string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT e.id
    FROM "ExternalDocument" e
    LEFT JOIN "JackSearchDoc" d ON d.source = 'document' AND d."sourceId" = e.id
    CROSS JOIN websearch_to_tsquery('english'::regconfig, ${query}::text) AS query
    WHERE e."deletedAt" IS NULL AND e.source = ANY(${sources}::text[])
      AND (d.search @@ query OR strpos(lower(e.name), lower(${query}::text)) > 0 OR strpos(lower(e.path), lower(${query}::text)) > 0)
    ORDER BY ts_rank(d.search, query) DESC NULLS LAST, e."modifiedAt" DESC
    LIMIT ${SEARCH_LIMIT}
  `
  return rows.map((row) => row.id)
}

/**
 * One page of the documents from these (switched-on) sources, newest change first, or best match first
 * when searching. `source` narrows to one of them. Removed documents aren't listed
 */
export async function listDocuments({ q = "", source, sources, page = 1 }: { q?: string; source?: string; sources: string[]; page?: number }): Promise<DocumentList> {
  const chosen = source && sources.includes(source) ? [source] : sources
  const grouped = sources.length ? await prisma.externalDocument.groupBy({ by: ["source"], where: { deletedAt: null, source: { in: sources } }, _count: { _all: true } }) : []
  const counts = Object.fromEntries(grouped.map((group) => [group.source, group._count._all]))
  if (!chosen.length) return { rows: [], total: 0, page: 1, pageCount: 1, counts }

  const query = q.trim().slice(0, 200)
  if (query) {
    const ids = await searchDocumentIds(query, chosen)
    const found = ids.length ? await prisma.externalDocument.findMany({ where: { id: { in: ids } }, select: documentSelect }) : []
    const rank = new Map(ids.map((id, i) => [id, i]))
    const ordered = found.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    return { ...pageOf(ordered, page), total: ordered.length, counts }
  }

  const where = { deletedAt: null, source: { in: chosen } }
  const total = await prisma.externalDocument.count({ where })
  const pageCount = Math.max(1, Math.ceil(total / DOCUMENTS_PAGE_SIZE))
  const current = Math.min(Math.max(1, page), pageCount)
  const rows = await prisma.externalDocument.findMany({ where, orderBy: [{ modifiedAt: "desc" }, { id: "asc" }], skip: (current - 1) * DOCUMENTS_PAGE_SIZE, take: DOCUMENTS_PAGE_SIZE, select: documentSelect })
  return { rows, total, page: current, pageCount, counts }
}

export type TeamsMessageListRow = {
  id: string
  channelId: string
  channelName: string | null
  teamId: string | null
  replyToId: string | null
  authorName: string
  excerpt: string
  createdAt: Date
  editedAt: Date | null
}

export type TeamsChannelOption = { id: string; name: string; messages: number }

export type TeamsMessageList = { rows: TeamsMessageListRow[]; total: number; page: number; pageCount: number; channels: TeamsChannelOption[] }

const messageSelect = { id: true, channelId: true, replyToId: true, authorName: true, content: true, createdAt: true, editedAt: true } satisfies Prisma.TeamsMessageSelect

async function searchMessageIds(query: string, channelId: string | undefined): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t.id
    FROM "TeamsMessage" t
    LEFT JOIN "JackSearchDoc" d ON d.source = 'teams' AND d."sourceId" = t.id
    CROSS JOIN websearch_to_tsquery('english'::regconfig, ${query}::text) AS query
    WHERE t."deletedAt" IS NULL AND (${channelId ?? null}::text IS NULL OR t."channelId" = ${channelId ?? null}::text)
      AND (d.search @@ query OR strpos(lower(t.content), lower(${query}::text)) > 0 OR strpos(lower(t."authorName"), lower(${query}::text)) > 0)
    ORDER BY ts_rank(d.search, query) DESC NULLS LAST, t."createdAt" DESC
    LIMIT ${SEARCH_LIMIT}
  `
  return rows.map((row) => row.id)
}

const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat
}

/** One page of synced Teams messages (deleted ones left out), newest first or best match first; `channelId` narrows to one channel */
export async function listTeamsMessages({ q = "", channelId, page = 1 }: { q?: string; channelId?: string; page?: number }): Promise<TeamsMessageList> {
  const [channelRows, perChannel] = await Promise.all([
    prisma.teamsChannel.findMany({ select: { id: true, name: true, teamId: true, synced: true }, orderBy: { name: "asc" } }),
    prisma.teamsMessage.groupBy({ by: ["channelId"], where: { deletedAt: null }, _count: { _all: true } }),
  ])
  const counts = new Map(perChannel.map((group) => [group.channelId, group._count._all]))
  const byId = new Map(channelRows.map((channel) => [channel.id, channel]))
  const channels = channelRows.filter((channel) => channel.synced || counts.has(channel.id)).map((channel) => ({ id: channel.id, name: channel.name, messages: counts.get(channel.id) ?? 0 }))
  const chosen = channelId && byId.has(channelId) ? channelId : undefined
  const toRow = (m: Prisma.TeamsMessageGetPayload<{ select: typeof messageSelect }>): TeamsMessageListRow => ({
    id: m.id,
    channelId: m.channelId,
    channelName: byId.get(m.channelId)?.name ?? null,
    teamId: byId.get(m.channelId)?.teamId ?? null,
    replyToId: m.replyToId,
    authorName: m.authorName,
    excerpt: excerpt(m.content),
    createdAt: m.createdAt,
    editedAt: m.editedAt,
  })

  const query = q.trim().slice(0, 200)
  if (query) {
    const ids = await searchMessageIds(query, chosen)
    const found = ids.length ? await prisma.teamsMessage.findMany({ where: { id: { in: ids } }, select: messageSelect }) : []
    const rank = new Map(ids.map((id, i) => [id, i]))
    const ordered = found.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)).map(toRow)
    return { ...pageOf(ordered, page), total: ordered.length, channels }
  }

  const where = { deletedAt: null, ...(chosen ? { channelId: chosen } : {}) }
  const total = await prisma.teamsMessage.count({ where })
  const pageCount = Math.max(1, Math.ceil(total / DOCUMENTS_PAGE_SIZE))
  const current = Math.min(Math.max(1, page), pageCount)
  const rows = await prisma.teamsMessage.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (current - 1) * DOCUMENTS_PAGE_SIZE, take: DOCUMENTS_PAGE_SIZE, select: messageSelect })
  return { rows: rows.map(toRow), total, page: current, pageCount, channels }
}
