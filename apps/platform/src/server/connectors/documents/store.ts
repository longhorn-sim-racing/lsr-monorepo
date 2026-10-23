import { prisma } from "@/server/db"
import type { DocumentTextStatus } from "./text"

/**
 * Writes to ExternalDocument for the Drive and SharePoint syncs (design §3.3, §12.7, §12.8). One store
 * per source ("drive", "sharepoint"); the syncs only talk to this interface, so their tests run against
 * an in-memory store (`testing.ts`) and the DB check script against a throwaway source.
 *
 * The search index (JackSearchDoc) follows the rows by trigger. A removed document keeps its row (name,
 * folder, link) with `deletedAt` set and its text nulled, so nothing it said stays searchable.
 */

/** What a sync knows about a file before reading its text */
export type DocumentMeta = {
  externalId: string
  driveId?: string | null
  name: string
  path: string
  mimeType: string
  webUrl: string
  modifiedAt: Date
  sizeBytes: number | null
  /** Drive's version or SharePoint's eTag: a file whose version didn't change isn't read again */
  version: string | null
}

export type StoredDocument = {
  id: string
  externalId: string
  name: string
  path: string
  webUrl: string
  version: string | null
  textStatus: string
  deletedAt: Date | null
}

export type DocumentStore = {
  /** "drive" or "sharepoint" (a check script uses a throwaway one) */
  source: string
  find(externalId: string): Promise<StoredDocument | null>
  /** Saves a file with its text (new, or changed since it was read), as not deleted */
  save(meta: DocumentMeta, text: { text: string | null; textStatus: DocumentTextStatus }, at: Date): Promise<void>
  /** A file that didn't change: its name, folder and link may have (a renamed folder), its text stays */
  touch(meta: DocumentMeta, at: Date): Promise<void>
  /** Marks a file removed and drops its text. True when it was there and not removed already */
  remove(externalId: string, at: Date): Promise<boolean>
  /** After a full walk: every file the walk didn't see (synced before it started) is removed. Returns how many */
  removeUnseen(walkStartedAt: Date, at: Date): Promise<number>
}

const storedSelect = { id: true, externalId: true, name: true, path: true, webUrl: true, version: true, textStatus: true, deletedAt: true } as const

export function prismaDocumentStore(source: string): DocumentStore {
  const columns = (meta: DocumentMeta) => ({
    driveId: meta.driveId ?? null,
    name: meta.name,
    path: meta.path,
    mimeType: meta.mimeType,
    webUrl: meta.webUrl,
    modifiedAt: meta.modifiedAt,
    sizeBytes: meta.sizeBytes === null ? null : BigInt(Math.max(0, Math.round(meta.sizeBytes))),
    version: meta.version,
  })
  return {
    source,
    find: (externalId) => prisma.externalDocument.findUnique({ where: { source_externalId: { source, externalId } }, select: storedSelect }),
    async save(meta, text, at) {
      const data = { ...columns(meta), text: text.text, textStatus: text.textStatus, syncedAt: at, deletedAt: null }
      await prisma.externalDocument.upsert({
        where: { source_externalId: { source, externalId: meta.externalId } },
        create: { source, externalId: meta.externalId, ...data },
        update: data,
      })
    },
    async touch(meta, at) {
      await prisma.externalDocument.update({ where: { source_externalId: { source, externalId: meta.externalId } }, data: { ...columns(meta), syncedAt: at } })
    },
    async remove(externalId, at) {
      const { count } = await prisma.externalDocument.updateMany({ where: { source, externalId, deletedAt: null }, data: { deletedAt: at, text: null, syncedAt: at } })
      return count > 0
    },
    async removeUnseen(walkStartedAt, at) {
      const { count } = await prisma.externalDocument.updateMany({ where: { source, deletedAt: null, syncedAt: { lt: walkStartedAt } }, data: { deletedAt: at, text: null } })
      return count
    },
  }
}
