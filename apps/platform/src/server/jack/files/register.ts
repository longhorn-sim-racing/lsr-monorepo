import { createHash } from "node:crypto"
import type { JackFile, Prisma } from "@prisma/client"
import { baseContentType, MAX_FILE_BYTES } from "@/lib/jack/files"
import type { JackFileItem } from "@/lib/jack/parts"
import { redactSecrets } from "@/lib/redact"
import { prisma } from "@/server/db"
import { jackFileStore, type JackFileStore } from "@/server/jack/decks/storage"
import { extractText } from "./extract"
import { imageCopies } from "./images"
import { checkContent } from "./magic"
import { derivedFilePath, filePaths } from "./paths"
import type { FileProblem, FileResult } from "./service"
import { jackFileItemSelect, toFileItem } from "./views"

/**
 * Step 3 of attaching a file (service.ts has the rest): checks an upload that arrived and gets it ready
 * for the room and for Jack. Kept apart because it loads the parsers (pdf.js, sharp, exceljs, mammoth),
 * which only the register route needs; the room's server actions import service.ts.
 */

const ok = <T>(data: T): FileResult<T> => ({ ok: true, data })
const problem = (code: FileProblem, error: string): FileResult<never> => ({ ok: false, error, code })

/**
 * Checks the object arrived whole, its magic bytes against its type, takes its sha256, makes the model
 * copy and thumbnail for photos, extracts text, and sets READY or FAILED. Only the officer who attached
 * it can register it. Registering a file that's already READY just returns it.
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

    const { count } = await prisma.jackFile.updateMany({ where: { id: row.id, status: "UPLOADING" }, data })
    if (!count && row.kind === "IMAGE" && !(await prisma.jackFile.findUnique({ where: { id: row.id }, select: { id: true } }))) {
      // Removed while it was being checked: the copies just stored belong to nothing, so they go too
      await store.delete(filePaths(row)).catch((error) => console.error(`[jack] Couldn't delete the copies of removed file ${row.id}:`, error))
    }
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
  await store.delete(filePaths(row)).catch((e) => console.error(`[jack] Couldn't delete refused file ${row.id}:`, e))
  return problem(code, error)
}
