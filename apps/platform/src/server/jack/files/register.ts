import { createHash } from "node:crypto"
import type { JackFile, Prisma } from "@prisma/client"
import { baseContentType, MAX_FILE_BYTES } from "@/lib/jack/files"
import type { JackFileItem } from "@/lib/jack/parts"
import { redactSecrets } from "@/lib/redact"
import { prisma } from "@/server/db"
import type { ClaudeFilesClient } from "@/server/connectors/anthropic/files"
import { jackFileStore, type JackFileStore } from "@/server/jack/decks/storage"
import { claudeFilesForUploads, claudeUploadType, deleteClaudeFiles, isEncryptedPdf, pdfFitsAsDocument, uploadToClaude } from "./claude"
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
 * How long the upload to Claude Files may take, so registration stays well inside the route's 60 s (a
 * PDF's upload runs alongside its text extraction, which stops itself at 25 s)
 */
export const CLAUDE_UPLOAD_BUDGET_MS = 20_000

/**
 * Checks the object arrived whole, its magic bytes against its type, takes its sha256, makes the model
 * copy and thumbnail for photos, extracts text, puts photos (their model copy) and PDFs on Claude Files
 * when that's switched on, and sets READY or FAILED. Only the officer who attached it can register it.
 * Registering a file that's already READY just returns it.
 *
 * A Claude Files upload that fails never fails the file: it's READY without a copy there, and Jack is
 * shown its text (PDFs) or its model copy (photos) instead, or a later turn uploads it. `claude` is for
 * tests; by default it's the Claude Files connector's client (null while switched off)
 */
export async function registerFile(
  fileId: string,
  officerId: string,
  store: JackFileStore = jackFileStore(),
  claude?: ClaudeFilesClient | null
): Promise<FileResult<JackFileItem>> {
  const row = await prisma.jackFile.findUnique({ where: { id: fileId } })
  if (!row) return problem("not_found", "That file is gone. Attach it again.")
  if (row.uploadedById !== officerId) return problem("forbidden", "Only the officer who attached a file can finish its upload.")
  if (row.status === "READY") return ok(toFileItem(row))
  if (row.status === "FAILED") return problem("bad_request", row.error ?? "This file couldn't be read.")

  // Only photos and PDFs go to Claude Files
  const client = !claudeUploadType(row.kind) ? null : claude === undefined ? await claudeFilesForUploads() : claude
  // The copy on Claude Files, once uploaded; `settled` once it's recorded on the row or deleted again
  let uploading: Promise<string | null> = Promise.resolve(null)
  let settled = false
  const dropUpload = async (id: string | null) => {
    settled = true
    if (id) await deleteClaudeFiles([id], { client })
  }

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
    // Whether Claude can take the upload as an image or a document; a PDF it can't isn't kept there
    let usable = true
    if (row.kind === "IMAGE") {
      const copies = await imageCopies(body).catch(() => null)
      if (!copies) return fail(store, row, "This image is damaged, or too large to open.")
      const modelCopyPath = derivedFilePath(row, "model")
      const thumbPath = derivedFilePath(row, "thumb")
      // Claude gets the model copy (no metadata, long edge ≤2000 px), uploaded while the copies are stored
      if (client) uploading = uploadToClaude(client, row, copies.model, AbortSignal.timeout(CLAUDE_UPLOAD_BUDGET_MS))
      await Promise.all([store.put(modelCopyPath, copies.model, "image/jpeg"), store.put(thumbPath, copies.thumb, "image/jpeg")])
      Object.assign(data, { modelCopyPath, thumbPath, width: copies.width, height: copies.height, textStatus: "none" })
    } else {
      // A PDF goes up while its text is read. An encrypted one never does: the API takes none, and one fails the whole request
      if (row.kind === "PDF" && client && !isEncryptedPdf(body)) uploading = uploadToClaude(client, row, body, AbortSignal.timeout(CLAUDE_UPLOAD_BUDGET_MS))
      const extraction = await extractText(row.kind, body)
      // Postgres text can't hold NUL characters (PDF text sometimes has them)
      Object.assign(data, { text: extraction.text?.replace(/\u0000/g, "") ?? null, textStatus: extraction.textStatus, pageCount: extraction.pageCount ?? null })
      usable = row.kind !== "PDF" || pdfFitsAsDocument({ pageCount: extraction.pageCount ?? null, textStatus: extraction.textStatus })
    }

    const claudeId = await uploading
    const kept = claudeId && usable ? claudeId : null
    if (kept) data.anthropicFileId = kept
    else await dropUpload(claudeId)

    const { count } = await prisma.jackFile.updateMany({ where: { id: row.id, status: "UPLOADING" }, data })
    // Registered by another request meanwhile, or removed: this copy on Claude Files belongs to nothing
    if (count) settled = true
    else await dropUpload(kept)
    if (!count && row.kind === "IMAGE" && !(await prisma.jackFile.findUnique({ where: { id: row.id }, select: { id: true } }))) {
      // Removed while it was being checked: the copies just stored belong to nothing, so they go too
      await store.delete(filePaths(row)).catch((error) => console.error(`[jack] Couldn't delete the copies of removed file ${row.id}:`, error))
    }
    return current(row.id)
  } catch (error) {
    console.error(`[jack] Registering file ${row.id} failed:`, redactSecrets(error instanceof Error ? error.message : String(error)))
    if (!settled) await dropUpload(await uploading).catch(() => {})
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
