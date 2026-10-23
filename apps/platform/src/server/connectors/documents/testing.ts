import type { DocumentMeta, DocumentStore, StoredDocument } from "./store"
import type { DocumentTextStatus } from "./text"

/** Test helper: a DocumentStore kept in memory, with the rows it holds. Not used by the app */

export type MemoryDocument = DocumentMeta & { id: string; text: string | null; textStatus: DocumentTextStatus | string; syncedAt: Date; deletedAt: Date | null }

export function memoryDocumentStore(source = "drive"): DocumentStore & { rows: Map<string, MemoryDocument>; live(): MemoryDocument[] } {
  const rows = new Map<string, MemoryDocument>()
  let next = 1
  const stored = (row: MemoryDocument): StoredDocument => ({
    id: row.id,
    externalId: row.externalId,
    name: row.name,
    path: row.path,
    webUrl: row.webUrl,
    version: row.version,
    textStatus: row.textStatus,
    deletedAt: row.deletedAt,
  })
  return {
    source,
    rows,
    live: () => [...rows.values()].filter((row) => !row.deletedAt),
    async find(externalId) {
      const row = rows.get(externalId)
      return row ? stored(row) : null
    },
    async save(meta, text, at) {
      // As Postgres does (error 22021)
      if (text.text?.includes("\u0000")) throw new Error('invalid byte sequence for encoding "UTF8": 0x00')
      const existing = rows.get(meta.externalId)
      rows.set(meta.externalId, { ...meta, id: existing?.id ?? `doc-${next++}`, text: text.text, textStatus: text.textStatus, syncedAt: at, deletedAt: null })
    },
    async touch(meta, at) {
      const existing = rows.get(meta.externalId)
      if (!existing) throw new Error(`No document ${meta.externalId} to touch`)
      rows.set(meta.externalId, { ...existing, ...meta, syncedAt: at })
    },
    async remove(externalId, at) {
      const row = rows.get(externalId)
      if (!row || row.deletedAt) return false
      rows.set(externalId, { ...row, deletedAt: at, text: null, syncedAt: at })
      return true
    },
    async removeUnseen(walkStartedAt, at) {
      let count = 0
      for (const [id, row] of rows) {
        if (row.deletedAt || row.syncedAt >= walkStartedAt) continue
        rows.set(id, { ...row, deletedAt: at, text: null })
        count++
      }
      return count
    },
  }
}
