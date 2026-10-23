import { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import { knowledgeHref } from "../links"
import { cleanSnippet, HEADLINE_INPUT_CHARS, HEADLINE_OPTIONS, isoOrNull, queryCte, rankOf } from "../sql"
import type { SearchSource } from "../types"

/**
 * Knowledge entries (design §9): what officers and Jack saved about the club. Archived entries aren't
 * searched. The memory track builds the entries and their page; this only reads the table.
 */

const DAY_MS = 86_400_000

/** What dates an entry: when it was reviewed, else when its source said it, else its last edit (design §3.3) */
export function knowledgeAgeDays(entry: { reviewedAt: Date | null; sourceDate: Date | null; updatedAt: Date }, now = new Date()): number {
  const basis = entry.reviewedAt ?? entry.sourceDate ?? entry.updatedAt
  return Math.max(0, Math.floor((now.getTime() - basis.getTime()) / DAY_MS))
}

type KnowledgeRow = {
  id: string
  title: string
  tags: string[]
  sourceType: string
  sourceNote: string | null
  sourceDate: Date | null
  reviewedAt: Date | null
  updatedAt: Date
  rank: number
  snippet: string | null
}

export const knowledgeSource: SearchSource = {
  key: "knowledge",
  description: "knowledge entries: decisions, how-tos, policies and who does what, saved by officers (or by you, marked not reviewed)",
  byDefault: true,
  async search({ query, limit }) {
    const rows = await prisma.$queryRaw<KnowledgeRow[]>(Prisma.sql`
      WITH ${queryCte(query)},
      hits AS (
        SELECT k.id, k.title, k.tags, k."sourceType"::text AS "sourceType", k."sourceNote", k."sourceDate", k."reviewedAt", k."updatedAt", k.body,
          ts_rank_cd(d.search, q.query, 32) AS rank
        FROM "JackSearchDoc" d
        CROSS JOIN q
        JOIN "KnowledgeEntry" k ON k.id = d."sourceId"
        WHERE d.source = 'knowledge' AND d.search @@ q.query AND k."archivedAt" IS NULL
        ORDER BY rank DESC, k."updatedAt" DESC
        LIMIT ${limit}
      )
      SELECT h.id, h.title, h.tags, h."sourceType", h."sourceNote", h."sourceDate", h."reviewedAt", h."updatedAt", h.rank,
        ts_headline('english', left(h.body, ${HEADLINE_INPUT_CHARS}::int), q.query, ${HEADLINE_OPTIONS}) AS snippet
      FROM hits h CROSS JOIN q
      ORDER BY h.rank DESC, h."updatedAt" DESC`)
    const now = new Date()
    return rows.map((row) => ({
      source: "knowledge",
      type: "knowledge",
      id: row.id,
      title: row.title,
      url: knowledgeHref(row.id),
      snippet: cleanSnippet(row.snippet),
      date: isoOrNull(row.reviewedAt ?? row.sourceDate ?? row.updatedAt),
      meta: {
        ageDays: knowledgeAgeDays(row, now),
        ...(row.sourceType === "JACK" && !row.reviewedAt ? { notReviewed: true } : {}),
        ...(row.tags.length ? { tags: row.tags.join(", ") } : {}),
        ...(row.sourceNote ? { from: row.sourceNote } : {}),
      },
      rank: rankOf(row.rank),
    }))
  },
  readers: [
    {
      type: "knowledge",
      description: "a knowledge entry, by id",
      async read(id) {
        const entry = await prisma.knowledgeEntry.findUnique({
          where: { id },
          select: {
            id: true,
            title: true,
            body: true,
            tags: true,
            sourceType: true,
            sourceUrl: true,
            sourceNote: true,
            sourceDate: true,
            reviewedAt: true,
            archivedAt: true,
            updatedAt: true,
            owner: { select: { displayName: true, handle: true } },
            versions: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } },
          },
        })
        if (!entry) return { ok: false, error: `No knowledge entry ${id}. Search for it again: it may have been deleted.` }
        return {
          ok: true,
          doc: {
            type: "knowledge",
            id: entry.id,
            title: entry.title,
            url: knowledgeHref(entry.id),
            date: isoOrNull(entry.reviewedAt ?? entry.sourceDate ?? entry.updatedAt),
            meta: {
              ageDays: knowledgeAgeDays(entry),
              ...(entry.sourceType === "JACK" && !entry.reviewedAt ? { notReviewed: true } : {}),
              ...(entry.archivedAt ? { archived: true } : {}),
              ...(entry.tags.length ? { tags: entry.tags.join(", ") } : {}),
              ...(entry.sourceNote ? { from: entry.sourceNote } : {}),
              ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
              ...(entry.owner ? { owner: `${entry.owner.displayName} (@${entry.owner.handle})` } : {}),
              // The memory track's updates name the version they change
              versionId: entry.versions[0]?.id ?? null,
            },
            text: entry.body,
          },
        }
      },
    },
  ],
}
