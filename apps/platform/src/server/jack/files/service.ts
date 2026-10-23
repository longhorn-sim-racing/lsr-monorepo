import { createHash, randomUUID } from "node:crypto"
import type { JackFile, Prisma } from "@prisma/client"
import { baseContentType, checkFile, MAX_FILE_BYTES, type JackUploadTicket } from "@/lib/jack/files"
import type { JackFileItem } from "@/lib/jack/parts"
import { redactSecrets } from "@/lib/redact"
import { prisma } from "@/server/db"
import { jackFileStore, type JackFileStore } from "@/server/jack/decks/storage"
import { extractText } from "./extract"
import { imageCopies } from "./images"
import { checkContent } from "./magic"
import { derivedFilePath, roomFilePath, storedPaths } from "./paths"
import { jackFileItemSelect, toFileItem } from "./views"

/**
 * Files officers attach in a room (#188, design §5):
 * 1. createUpload: checks the name, type and size, saves the JackFile row (UPLOADING) and returns a
 *    signed upload URL for exactly `rooms/<roomId>/<fileId>/<sanitized name>`.
 * 2. The browser uploads straight to Supabase Storage (or, with the local files store, to
 *    /api/admin/jack/files/[id]/upload).
 * 3. registerFile: checks the object arrived whole, its magic bytes against its type, takes its
 *    sha256, makes the model copy and thumbnail for photos, extracts text, and sets READY or FAILED.
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
 * Checks an upload that arrived and gets it ready for the room and for Jack. Only the officer who
 * attached it can register it. Registering a file that's already READY just returns it.
 */
export async function registerFile(fileId: string, officerId: string, store: JackFileStore = jackFileStore()): Promise<FileResult<JackFileItem>> {
  const row = await prisma.jackFile.findUnique({ where: { id: fileId } })
  if (!row) return problem("not_found", "That file is gone. Attach it again.")
  if (row.uploadedById !== officerId) return problem("forbidden", "Only the officer who attached a file can finish its upload.")
  if (row.status === "READY") return ok(toFileItem(row))
  if (row.status === "FAILED") return problem("bad_request", row.error ?? "This file couldn't be read.")

  try {
    const stored = await store.head(row.storagePath)
    if (!stored) return fail(store, row, "The upload didn't arrive. Attach the file again.")
    if (stored.size !== row.sizeBytes || stored.size > MAX_FILE_BYTES) return fail(store, row, "The file that arrived isn't the size the upload said. Attach it again.")
    if (stored.contentType && baseContentType(stored.contentType) !== row.contentType) return fail(store, row, "The file that arrived isn't the type the upload said. Attach it again.")
    const body = await store.get(row.storagePath)
    if (!body || body.length !== row.sizeBytes) return fail(store, row, "The upload didn't arrive whole. Attach the file again.")

    const content = checkContent(row.contentType, body)
    if (!content.ok) return fail(store, row, content.error)

    const data: Prisma.JackFileUpdateManyMutationInput = { status: "READY", error: null, sha256: createHash("sha256").update(body).digest("hex") }
    if (row.kind === "IMAGE") {
      const copies = await imageCopies(body).catch(() => null)
      if (!copies) return fail(store, row, "This image is damaged, or too large to open.")
      const modelCopyPath = derivedFilePath(row, "model")
      const thumbPath = derivedFilePath(row, "thumb")
      await Promise.all([store.put(modelCopyPath, copies.model, "image/jpeg"), store.put(thumbPath, copies.thumb, "image/jpeg")])
      Object.assign(data, { modelCopyPath, thumbPath, width: copies.width, height: copies.height, textStatus: "none" })
    } else {
      const extraction = await extractText(row.kind, body)
      // Postgres text can't hold NUL characters (PDF text sometimes has them)
      Object.assign(data, { text: extraction.text?.replace(/\u0000/g, "") ?? null, textStatus: extraction.textStatus, pageCount: extraction.pageCount ?? null })
    }

    await prisma.jackFile.updateMany({ where: { id: row.id, status: "UPLOADING" }, data })
    return current(row.id)
  } catch (error) {
    console.error(`[jack] Registering file ${row.id} failed:`, redactSecrets(error instanceof Error ? error.message : String(error)))
    return fail(store, row, "Couldn't check this file. Attach it again, and tell the Tech Team if it keeps failing.", "unavailable")
  }
}

/** The file as saved now: another request may have registered (or removed) it meanwhile */
async function current(fileId: string): Promise<FileResult<JackFileItem>> {
  const saved = await prisma.jackFile.findUnique({ where: { id: fileId }, select: { ...jackFileItemSelect, status: true, error: true } })
  if (!saved) return problem("not_found", "That file is gone. Attach it again.")
  if (saved.status === "READY") return ok(toFileItem(saved))
  return problem("bad_request", saved.error ?? "This file couldn't be read.")
}

/** Marks an upload FAILED with a message for the officer and deletes what it stored; a refused file isn't kept */
async function fail(store: JackFileStore, row: JackFile, message: string, code: FileProblem = "bad_request"): Promise<FileResult<JackFileItem>> {
  const error = redactSecrets(message, { maxLength: 300 })
  const { count } = await prisma.jackFile.updateMany({ where: { id: row.id, status: "UPLOADING" }, data: { status: "FAILED", error } })
  if (!count) {
    // Another request registered it first
    const saved = await current(row.id)
    if (saved.ok) return saved
  }
  await store.delete([row.storagePath, derivedFilePath(row, "model"), derivedFilePath(row, "thumb")]).catch((e) => console.error(`[jack] Couldn't delete refused file ${row.id}:`, e))
  return problem(code, error)
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

/** Removes a file the officer attached but hasn't posted (the chip's remove button). Gone already is fine */
export async function removeUpload(fileId: string, officerId: string, store: JackFileStore = jackFileStore()): Promise<FileResult<null>> {
  const row = await prisma.jackFile.findUnique({ where: { id: fileId } })
  if (!row) return ok(null)
  if (row.uploadedById !== officerId) return problem("forbidden", "Only the officer who attached a file can remove it.")
  if (row.messageId) return problem("bad_request", "This file is already posted in the room.")
  const { count } = await prisma.jackFile.deleteMany({ where: { id: fileId, messageId: null } })
  if (!count) return problem("bad_request", "This file is already posted in the room.")
  await store.delete(storedPaths(row)).catch((error) => {
    // The row is gone; the cleanup job can't find these anymore, so say which
    console.error(`[jack] Couldn't delete the stored copies of removed file ${row.id}:`, error)
  })
  return ok(null)
}
