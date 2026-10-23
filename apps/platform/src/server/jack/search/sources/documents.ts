import { Prisma } from "@prisma/client"
import { enabledDocumentSources } from "@/server/connectors/documents/sources"
import { prisma } from "@/server/db"
import { cleanSnippet, HEADLINE_INPUT_CHARS, HEADLINE_OPTIONS, isoOrNull, queryCte, rankOf } from "../sql"
import type { SearchSource } from "../types"

/**
 * Documents from the club's Google Drive folder and SharePoint site (design §12.7, §12.8), synced by
 * the documents track. Deleted files keep their row but lose their text, and aren't searched. Only
 * sources whose connector is switched on are searched or read.
 */

const SOURCE_LABEL: Record<string, string> = { drive: "Google Drive", sharepoint: "SharePoint" }

export const DOCUMENTS_OFF = "Google Drive and SharePoint aren't connected, so documents can't be searched or read."

/** Why a document has no text to read (ExternalDocument.textStatus) */
const NO_TEXT: Record<string, string> = {
  too_large: "is too large to have its text read",
  unsupported: "is a kind of file whose text isn't read",
  restricted: "can't be read: its owner turned off downloads for viewers",
  none: "has no text in it (a scan or a picture, say)",
  error: "couldn't have its text read",
}

type DocumentRow = {
  id: string
  name: string
  path: string
  source: string
  webUrl: string
  mimeType: string
  modifiedAt: Date
  rank: number
  snippet: string | null
}

export const documentsSource: SearchSource = {
  key: "documents",
  description: "documents in the club's Google Drive folder and SharePoint site (name, folder and text)",
  byDefault: true,
  async unavailable() {
    return (await enabledDocumentSources()).length ? null : DOCUMENTS_OFF
  },
  async search({ query, limit }) {
    const sources: string[] = await enabledDocumentSources()
    const rows = await prisma.$queryRaw<DocumentRow[]>(Prisma.sql`
      WITH ${queryCte(query)},
      hits AS (
        SELECT e.id, e.name, e.path, e.source, e."webUrl", e."mimeType", e."modifiedAt", coalesce(e.text, e.name) AS body,
          ts_rank_cd(d.search, q.query, 32) AS rank
        FROM "JackSearchDoc" d
        CROSS JOIN q
        JOIN "ExternalDocument" e ON e.id = d."sourceId"
        WHERE d.source = 'document' AND d.search @@ q.query AND e."deletedAt" IS NULL AND e.source = ANY(${sources}::text[])
        ORDER BY rank DESC, e."modifiedAt" DESC
        LIMIT ${limit}
      )
      SELECT h.id, h.name, h.path, h.source, h."webUrl", h."mimeType", h."modifiedAt", h.rank,
        ts_headline('english', left(h.body, ${HEADLINE_INPUT_CHARS}::int), q.query, ${HEADLINE_OPTIONS}) AS snippet
      FROM hits h CROSS JOIN q
      ORDER BY h.rank DESC, h."modifiedAt" DESC`)
    return rows.map((row) => ({
      source: "documents",
      type: "document",
      id: row.id,
      title: row.name,
      url: row.webUrl,
      snippet: cleanSnippet(row.snippet),
      date: isoOrNull(row.modifiedAt),
      meta: { in: SOURCE_LABEL[row.source] ?? row.source, folder: row.path },
      rank: rankOf(row.rank),
    }))
  },
  readers: [
    {
      type: "document",
      description: "a Drive or SharePoint document's text, by id",
      async read(id) {
        const doc = await prisma.externalDocument.findUnique({
          where: { id },
          select: { id: true, name: true, path: true, source: true, webUrl: true, mimeType: true, modifiedAt: true, text: true, textStatus: true, deletedAt: true },
        })
        if (!doc) return { ok: false, error: `No document ${id}. Search for it again.` }
        const on: string[] = await enabledDocumentSources()
        if (!on.includes(doc.source)) {
          return { ok: false, error: `${SOURCE_LABEL[doc.source] ?? doc.source} isn't connected, so its documents can't be read.` }
        }
        if (doc.deletedAt) return { ok: false, error: `${doc.name} was removed from ${SOURCE_LABEL[doc.source] ?? doc.source}, so its text is gone.` }
        if (doc.text === null) return { ok: false, error: `${doc.name} ${NO_TEXT[doc.textStatus] ?? "has no text yet"}. Its link: ${doc.webUrl}` }
        return {
          ok: true,
          doc: {
            type: "document",
            id: doc.id,
            title: doc.name,
            url: doc.webUrl,
            date: isoOrNull(doc.modifiedAt),
            meta: { in: SOURCE_LABEL[doc.source] ?? doc.source, folder: doc.path, kind: doc.mimeType, ...(doc.textStatus === "truncated" ? { partial: "only the start of its text was kept" } : {}) },
            text: doc.text,
          },
        }
      },
    },
  ],
}
