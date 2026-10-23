import type { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import { jackFileStore, type JackFileStore } from "@/server/jack/decks/storage"
import { storedPaths } from "./paths"

/**
 * Deletes room files nobody will use (design §5), with their stored copies: uploads that never
 * finished (still UPLOADING after 24 hours) and files never posted with a message after 7 days
 * (removed chips, failed uploads, a tab closed before sending). Files a meeting uses as its
 * transcript are kept. Run daily by the `files.cleanup` job (scheduler/jobs/files.ts).
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

export type CleanupResult = { deleted: number; objects: number; objectErrors: number; more: boolean }

export async function cleanupRoomFiles({ now = new Date(), signal, store = jackFileStore(), limit = CLEANUP_BATCH }: { now?: Date; signal?: AbortSignal; store?: JackFileStore; limit?: number } = {}): Promise<CleanupResult> {
  const where = cleanupWhere(now)
  const due = await prisma.jackFile.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: limit + 1,
    select: { id: true, storagePath: true, modelCopyPath: true, thumbPath: true },
  })
  const paths: string[] = []
  let deleted = 0
  for (const file of due.slice(0, limit)) {
    if (signal?.aborted) break
    // The row goes first, and only if it's still due (posted since? kept): a posted file never loses its bytes
    const { count } = await prisma.jackFile.deleteMany({ where: { AND: [{ id: file.id }, where] } })
    if (!count) continue
    deleted++
    paths.push(...storedPaths(file))
  }
  let objectErrors = 0
  if (paths.length) {
    try {
      await store.delete(paths)
    } catch (error) {
      objectErrors = paths.length
      console.error(`[jack] File cleanup removed ${deleted} rows but couldn't delete their ${paths.length} stored objects:`, error instanceof Error ? error.message : error)
    }
  }
  return { deleted, objects: paths.length - objectErrors, objectErrors, more: due.length > limit || (signal?.aborted ?? false) }
}
