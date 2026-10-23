import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { checkFile, MAX_FILE_BYTES, type JackUploadTicket } from "@/lib/jack/files"
import { redactSecrets } from "@/lib/redact"
import { prisma } from "@/server/db"
import type { ClaudeFilesClient } from "@/server/connectors/anthropic/files"
import { jackFileStore, type JackFileStore } from "@/server/jack/decks/storage"
import { claudeFilesForCleanup, deleteClaudeFiles } from "./claude"
import { filePaths, roomFilePath } from "./paths"

/**
 * Files officers attach in a room (#188, design §5):
 * 1. createUpload: checks the name, type and size, saves the JackFile row (UPLOADING) and returns a
 *    signed upload URL for exactly `rooms/<roomId>/<fileId>/<sanitized name>`.
 * 2. The browser uploads straight to Supabase Storage (or, with the local files store, to
 *    /api/admin/jack/files/[id]/upload).
 * 3. registerFile (register.ts): checks the object arrived whole, its magic bytes against its type,
 *    takes its sha256, makes the model copy and thumbnail for photos, extracts text, puts photos and
 *    PDFs on Claude Files (claude.ts), and sets READY or FAILED. Kept apart so the room's server
 *    actions, which import this file, never load the parsers.
 * 4. Posting a message links READY files to it (attach.ts).
 * Files never attached are deleted by the cleanup job (cleanup.ts).
 */

export type FileProblem = "bad_request" | "not_found" | "forbidden" | "unavailable"
export type FileResult<T> = { ok: true; data: T } | { ok: false; error: string; code: FileProblem }

/** Files an officer can have waiting (uploaded, not yet posted) in one room in a day */
export const MAX_PENDING_UPLOADS = 20

const DAY_MS = 24 * 60 * 60 * 1000

const NO_UPLOADS =
  "Attaching files needs Supabase Storage, which isn't set up here. An admin can set it up (SUPABASE_SERVICE_ROLE_KEY and the `jack` bucket; see docs/jack-2/tracks/files.md)."

const ok = <T>(data: T): FileResult<T> => ({ ok: true, data })
const problem = (code: FileProblem, error: string): FileResult<never> => ({ ok: false, error, code })

export async function createUpload(
  officerId: string,
  input: { roomId: string; filename: string; size: number; type: string },
  store: JackFileStore = jackFileStore()
): Promise<FileResult<JackUploadTicket>> {
  const check = checkFile({ name: input.filename, type: input.type, size: input.size })
  if (!check.ok) return problem("bad_request", check.error)

  const room = await prisma.jackRoom.findFirst({ where: { id: input.roomId, archivedAt: null }, select: { id: true } })
  if (!room) return problem("not_found", "That room doesn't exist anymore.")

  const local = store.kind === "files"
  if (!local && !store.signedUploadUrl) return problem("unavailable", NO_UPLOADS)

  const waiting = await prisma.jackFile.count({
    where: { roomId: room.id, uploadedById: officerId, messageId: null, status: { not: "FAILED" }, createdAt: { gte: new Date(Date.now() - DAY_MS) } },
  })
  if (waiting >= MAX_PENDING_UPLOADS) return problem("bad_request", `You have ${waiting} files waiting in this room. Send or remove some first.`)

  const id = randomUUID()
  const storagePath = roomFilePath(room.id, id, check.storageName)
  await prisma.jackFile.create({
    data: {
      id,
      roomId: room.id,
      uploadedById: officerId,
      filename: check.filename,
      contentType: check.contentType,
      sizeBytes: input.size,
      storagePath,
      kind: check.kind,
      status: "UPLOADING",
    },
  })

  try {
    const url = local ? `/api/admin/jack/files/${id}/upload` : (await store.signedUploadUrl!(storagePath)).url
    return ok({ file: { id, filename: check.filename, kind: check.kind, sizeBytes: input.size }, url, contentType: check.contentType })
  } catch (error) {
    console.error(`[jack] Couldn't sign an upload for file ${id}:`, redactSecrets(error instanceof Error ? error.message : String(error)))
    await prisma.jackFile.delete({ where: { id } }).catch(() => {})
    return problem("unavailable", "Couldn't start the upload. Try again in a minute.")
  }
}

/**
 * The local files store's stand-in for a signed upload (development only, store kind "files"): saves
 * the bytes for an UPLOADING file of this officer's, once, like Supabase's signed upload with upsert off
 */
export async function storeLocalUpload(fileId: string, officerId: string, body: Buffer, store: JackFileStore = jackFileStore()): Promise<FileResult<null>> {
  if (store.kind !== "files") return problem("not_found", "Uploads go straight to Supabase Storage here.")
  const row = await prisma.jackFile.findUnique({ where: { id: fileId }, select: { status: true, uploadedById: true, storagePath: true } })
  if (!row || row.status !== "UPLOADING") return problem("not_found", "That upload isn't waiting for a file.")
  if (row.uploadedById !== officerId) return problem("forbidden", "Only the officer who attached a file can upload it.")
  if (body.length > MAX_FILE_BYTES) return problem("bad_request", "This file is over the size limit.")
  if (await store.head(row.storagePath)) return problem("bad_request", "This file was already uploaded.")
  await store.put(row.storagePath, body, "application/octet-stream")
  return ok(null)
}

/**
 * Removes a file the officer attached but hasn't posted (the chip's remove button), with its stored
 * copies and its copy on Claude Files. Gone already is fine. `claude` is for tests
 */
export async function removeUpload(fileId: string, officerId: string, store: JackFileStore = jackFileStore(), claude?: ClaudeFilesClient | null): Promise<FileResult<null>> {
  const row = await prisma.jackFile.findUnique({ where: { id: fileId } })
  if (!row) return ok(null)
  if (row.uploadedById !== officerId) return problem("forbidden", "Only the officer who attached a file can remove it.")
  if (row.messageId) return problem("bad_request", "This file is already posted in the room.")
  // The row as it was deleted: a registration may have recorded its Claude Files copy since it was read
  let removed: typeof row
  try {
    removed = await prisma.jackFile.delete({ where: { id: fileId, messageId: null } })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025")) throw error
    // Posted meanwhile, or removed by another request
    const still = await prisma.jackFile.findUnique({ where: { id: fileId }, select: { id: true } })
    return still ? problem("bad_request", "This file is already posted in the room.") : ok(null)
  }
  // Photo copies too, recorded or not (registration stores them before recording them, and deletes any it stores after this)
  await store.delete(filePaths(removed)).catch((error) => {
    // The row is gone; the cleanup job's sweep deletes them later
    console.error(`[jack] Couldn't delete the stored copies of removed file ${removed.id}:`, error)
  })
  // A registration that records its copy after this finds the row gone and deletes the copy itself (register.ts)
  if (removed.anthropicFileId) await deleteClaudeFiles([removed.anthropicFileId], { client: claude === undefined ? claudeFilesForCleanup() : claude })
  return ok(null)
}
