import type { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import type { ClaudeFilesClient } from "@/server/connectors/anthropic/files"
import { jackFileStore, type JackFileStore } from "@/server/jack/decks/storage"
import { claudeFilesForCleanup, DELETES_AT_ONCE, deleteClaudeFiles } from "./claude"
import { fileIdOfPath, filePaths, storedPaths } from "./paths"

/**
 * Deletes room files nobody will use (design §5), with their stored copies and their copies on Claude
 * Files: uploads that never finished (still UPLOADING after 24 hours) and files never posted with a
 * message after 7 days (removed chips, failed uploads, a tab closed before sending). Files a meeting
 * uses as its transcript are kept. Then sweeps the store for room files no row points at. Run daily by
 * the `files.cleanup` job (scheduler/jobs/files.ts).
 *
 * There's no sweep for Claude Files: the key's workspace can hold other environments' files (a local
 * database doesn't know production's), so only copies whose rows are deleted here are deleted. Each
 * copy goes before its row, so none is left that no row points at; and every copy expires by itself
 * anyway (CLAUDE_FILES_EXPIRY_S).
 */

export const ABANDONED_UPLOAD_MS = 24 * 60 * 60 * 1000
export const NEVER_ATTACHED_MS = 7 * 24 * 60 * 60 * 1000

/** Rows deleted per run; the next run takes the rest */
export const CLEANUP_BATCH = 200

/** Which files are due for deletion at `now` */
export function cleanupWhere(now: Date): Prisma.JackFileWhereInput {
  return {
    meetingsAsTranscript: { none: {} },
    OR: [
      { status: "UPLOADING", createdAt: { lt: new Date(now.getTime() - ABANDONED_UPLOAD_MS) } },
      { messageId: null, createdAt: { lt: new Date(now.getTime() - NEVER_ATTACHED_MS) } },
    ],
  }
}

/**
 * `objects` counts the copies the deleted rows recorded; photo copies a registration stored but never
 * recorded are deleted too. `claudeFiles` counts their copies deleted from Claude Files, and
 * `claudeErrors` the ids of deleted rows whose copy couldn't be (the API failed, or there's no key;
 * logged, and they expire by themselves)
 */
export type CleanupResult = { deleted: number; objects: number; objectErrors: number; claudeFiles: number; claudeErrors: string[]; more: boolean }

export async function cleanupRoomFiles({
  now = new Date(),
  signal,
  store = jackFileStore(),
  claude = claudeFilesForCleanup(),
  limit = CLEANUP_BATCH,
}: { now?: Date; signal?: AbortSignal; store?: JackFileStore; claude?: ClaudeFilesClient | null; limit?: number } = {}): Promise<CleanupResult> {
  const where = cleanupWhere(now)
  const due = await prisma.jackFile.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: limit + 1,
    select: { id: true, roomId: true, storagePath: true, modelCopyPath: true, thumbPath: true, anthropicFileId: true },
  })
  const paths = new Set<string>()
  const claudeErrors: string[] = []
  let deleted = 0
  let objects = 0
  let claudeFiles = 0
  const batch = due.slice(0, limit)
  for (let i = 0; i < batch.length && !signal?.aborted; i += DELETES_AT_ONCE) {
    const chunk = batch.slice(i, i + DELETES_AT_ONCE)
    // Copies on Claude Files go before their rows. One the time limit cut short keeps its row, and the
    // next run deletes both; a file posted meanwhile keeps its row, and its next turn uploads it again.
    // A registration still uploading when its row goes deletes its own copy (register.ts)
    const copies = await deleteClaudeFiles(chunk.flatMap((file) => (file.anthropicFileId ? [file.anthropicFileId] : [])), { client: claude, signal })
    claudeFiles += copies.deleted
    const stopped = signal?.aborted ?? false
    const failed = new Set(copies.failed)
    for (const file of chunk) {
      const copyLeft = file.anthropicFileId !== null && failed.has(file.anthropicFileId)
      if (copyLeft && stopped) continue
      // Only if it's still due (posted since? kept): a posted file never loses its bytes
      const { count } = await prisma.jackFile.deleteMany({ where: { AND: [{ id: file.id }, where] } })
      if (!count) continue
      deleted++
      objects += storedPaths(file).length
      for (const path of [...storedPaths(file), ...filePaths(file)]) paths.add(path)
      // The API failed, or there's no key: the row goes anyway, so these can't fill every batch, and the copy expires by itself
      if (copyLeft) claudeErrors.push(file.anthropicFileId!)
    }
  }
  let objectErrors = 0
  if (paths.size) {
    try {
      await store.delete([...paths])
    } catch (error) {
      objectErrors = objects
      console.error(`[jack] File cleanup removed ${deleted} rows but couldn't delete their stored objects:`, error instanceof Error ? error.message : error)
    }
  }
  return {
    deleted,
    objects: objects - objectErrors,
    objectErrors,
    claudeFiles,
    claudeErrors,
    more: due.length > limit || (signal?.aborted ?? false),
  }
}

/**
 * How old a stored room file must be before the sweep may take it. A file's row is always saved
 * before anything is stored for it, so an object with no row is a leftover whatever its age; this is
 * only a margin
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Deletes stored room files (under `rooms/`) that no JackFile row points at: an upload that landed
 * after its file was removed (a signed upload link works for 2 hours), or copies left behind when
 * deleting them failed. Deck files (`jack/…`) are never touched.
 */
export async function sweepOrphanFiles({ now = new Date(), signal, store = jackFileStore(), pageSize = 1_000 }: { now?: Date; signal?: AbortSignal; store?: JackFileStore; pageSize?: number } = {}): Promise<{ deleted: number; more: boolean }> {
  let cursor: string | undefined
  let deleted = 0
  do {
    if (signal?.aborted) return { deleted, more: true }
    const page = await store.list("rooms/", { cursor, limit: pageSize })
    const byFile = new Map<string, string[]>()
    for (const item of page.items) {
      const fileId = fileIdOfPath(item.pathname)
      if (!fileId || (item.uploadedAt && now.getTime() - item.uploadedAt.getTime() < ORPHAN_GRACE_MS)) continue
      byFile.set(fileId, [...(byFile.get(fileId) ?? []), item.pathname])
    }
    if (byFile.size) {
      const known = await prisma.jackFile.findMany({ where: { id: { in: [...byFile.keys()] } }, select: { id: true } })
      for (const { id } of known) byFile.delete(id)
      const orphans = [...byFile.values()].flat()
      if (orphans.length) {
        await store.delete(orphans)
        deleted += orphans.length
      }
    }
    cursor = page.cursor ?? undefined
  } while (cursor)
  return { deleted, more: false }
}
