import type { JackFileKindKey } from "@/lib/jack/parts"
import { redactSecrets } from "@/lib/redact"
import { prisma } from "@/server/db"
import { CLAUDE_FILES_CONNECTOR, claudeFilesClient, claudeFilesConnector, type ClaudeFilesClient } from "@/server/connectors/anthropic/files"
import { fakesEnabledFor } from "@/server/connectors/base-url"
import { errorText, recordConnectorError, recordConnectorSync } from "@/server/connectors/state"
import type { JackFileStore } from "@/server/jack/decks/storage"

/**
 * Room files on Claude's Files API (design §5). Photos go up as their model copy (JPEG, no metadata,
 * long edge ≤2000 px) and PDFs as they are, once, so a turn or a room_files read sends an id instead of
 * the bytes. The id is JackFile.anthropicFileId, written only here, on the server.
 *
 * Uploading and showing files need the Claude Files connector switched on; deleting what was uploaded
 * works whenever the key is set, so switching it off never strands a copy.
 */

/** PDFs Claude reads as documents at most this long (design §5: 100 pages a turn); longer ones go as text */
export const MAX_DOCUMENT_PAGES = 100

/** What a file goes up as: PDFs as PDFs, photos as their JPEG model copy; nothing else goes */
export function claudeUploadType(kind: JackFileKindKey): "application/pdf" | "image/jpeg" | null {
  return kind === "PDF" ? "application/pdf" : kind === "IMAGE" ? "image/jpeg" : null
}

/** The name it goes up under: our id, never the officer's file name (which can say anything) */
export function claudeUploadName(fileId: string, kind: JackFileKindKey): string {
  return `jack-${fileId}.${kind === "PDF" ? "pdf" : "jpg"}`
}

/**
 * Whether a PDF can go to Claude as a document: pdf.js opened it (so its page count is known) and it's
 * not too long. A PDF the API can't open fails the whole request it's in, so one pdf.js couldn't read
 * goes as nothing but a note
 */
export function pdfFitsAsDocument(file: { pageCount: number | null; textStatus: string | null }): boolean {
  return file.pageCount !== null && file.pageCount > 0 && file.pageCount <= MAX_DOCUMENT_PAGES && file.textStatus !== "failed"
}

/**
 * A PDF with an /Encrypt dictionary (even one that opens without a password). The API takes no
 * encrypted PDFs, and one in a request fails all of it, so these are never uploaded and go as text
 */
export function isEncryptedPdf(body: Uint8Array): boolean {
  return Buffer.from(body.buffer, body.byteOffset, body.length).includes("/Encrypt")
}

/**
 * Whether Files API ids may go to the model at all. With JACK_FAKES covering "anthropic" the files are
 * in the local fake, which the real Messages API can't read, so turns fall back to copies and text
 */
export function claudeIdsReachModel(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !fakesEnabledFor("anthropic", env)
}

/** The client for uploading and showing files: null unless the key is set and Claude Files is switched on. Never throws */
export async function claudeFilesForUploads(): Promise<ClaudeFilesClient | null> {
  try {
    return await claudeFilesConnector.client()
  } catch (error) {
    console.error("[jack] Couldn't check whether Claude Files is on:", redactSecrets(errorText(error)))
    return null
  }
}

/** The client for deleting uploaded files: whenever the key is set, switched on or not */
export function claudeFilesForCleanup(env: Readonly<Record<string, string | undefined>> = process.env): ClaudeFilesClient | null {
  const key = env.ANTHROPIC_API_KEY?.trim()
  return key ? claudeFilesClient(key, env) : null
}

/** Uploads one file's bytes; the new id, or null when it failed (logged, and shown on the Connections page) */
export async function uploadToClaude(client: ClaudeFilesClient, file: { id: string; kind: JackFileKindKey }, bytes: Uint8Array, signal?: AbortSignal): Promise<string | null> {
  const type = claudeUploadType(file.kind)
  if (!type) return null
  try {
    const { id } = await client.upload({ name: claudeUploadName(file.id, file.kind), bytes, type }, { signal })
    await recordConnectorSync(CLAUDE_FILES_CONNECTOR).catch(() => {})
    return id
  } catch (error) {
    const stored = await recordConnectorError(CLAUDE_FILES_CONNECTOR, error).catch(() => redactSecrets(errorText(error)))
    console.error(`[jack] Couldn't upload file ${file.id} to Claude Files: ${stored}`)
    return null
  }
}

/**
 * Deletes uploaded copies. One that's already gone counts as deleted. `failed` lists the ids that
 * couldn't be (no key, or the API failed); they're logged, since nothing points at them any more
 */
export async function deleteClaudeFiles(ids: string[], { client = claudeFilesForCleanup(), signal }: { client?: ClaudeFilesClient | null; signal?: AbortSignal } = {}): Promise<{ deleted: number; failed: string[] }> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return { deleted: 0, failed: [] }
  if (!client) {
    console.error(`[jack] Couldn't delete ${unique.length} Claude file(s) (${unique.join(", ")}): ANTHROPIC_API_KEY isn't set`)
    return { deleted: 0, failed: unique }
  }
  let deleted = 0
  const failed: string[] = []
  for (let i = 0; i < unique.length; i += DELETES_AT_ONCE) {
    await Promise.all(
      unique.slice(i, i + DELETES_AT_ONCE).map(async (id) => {
        try {
          if (signal?.aborted) throw new Error("stopped at the time limit")
          await client.remove(id, { signal })
          deleted++
        } catch (error) {
          failed.push(id)
          console.error(`[jack] Couldn't delete Claude file ${id}: ${redactSecrets(errorText(error))}`)
        }
      })
    )
  }
  return { deleted, failed }
}

/** Deletes sent at once (the Files API allows about 500 file requests a minute) */
const DELETES_AT_ONCE = 8

export type ClaudeCandidate = {
  id: string
  kind: JackFileKindKey
  storagePath: string
  modelCopyPath: string | null
  anthropicFileId: string | null
  pageCount: number | null
  textStatus: string | null
}

/** The columns ensureClaudeIds needs */
export const claudeCandidateSelect = { id: true, kind: true, storagePath: true, modelCopyPath: true, anthropicFileId: true, pageCount: true, textStatus: true } as const

/**
 * The Files API id of each file that can go to Claude as an image or a document, by file id:
 * - a recorded id is checked first (one list call for all of them): a deleted or expired copy, or one
 *   in another workspace (after a key change), is forgotten, so the request never names a file the API
 *   can't find, which would fail the whole request;
 * - a file with no copy (registered while Claude Files was off, or its upload failed) is uploaded now
 *   from the store, when `upload` is set.
 * Anything that fails is left out, and the caller shows the file another way. Never throws.
 */
export async function ensureClaudeIds(
  client: ClaudeFilesClient,
  files: ClaudeCandidate[],
  { store, signal, upload = true }: { store: JackFileStore; signal?: AbortSignal; upload?: boolean }
): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  const eligible = files.filter((file) => file.kind === "IMAGE" ? Boolean(file.modelCopyPath) : file.kind === "PDF" && pdfFitsAsDocument(file))
  const recorded = eligible.filter((file) => file.anthropicFileId)
  let visible: Set<string> | null = null
  if (recorded.length) {
    try {
      visible = await client.visible(recorded.map((file) => file.anthropicFileId!), { signal })
    } catch (error) {
      // Can't tell: trust what's recorded (a Files API that's down fails the request either way)
      console.error("[jack] Couldn't check Claude Files copies:", redactSecrets(errorText(error)))
    }
  }
  const missing: ClaudeCandidate[] = []
  for (const file of eligible) {
    if (file.anthropicFileId && (!visible || visible.has(file.anthropicFileId))) ids.set(file.id, file.anthropicFileId)
    else missing.push(file)
  }
  // Forget the copies that are gone, so nothing tries them again
  const stale = missing.filter((file) => file.anthropicFileId)
  await Promise.all(stale.map((file) => prisma.jackFile.updateMany({ where: { id: file.id, anthropicFileId: file.anthropicFileId }, data: { anthropicFileId: null } }).catch(() => null)))

  if (upload && missing.length) {
    await Promise.all(
      missing.map(async (file) => {
        try {
          const bytes = await store.get(file.kind === "IMAGE" ? file.modelCopyPath! : file.storagePath)
          if (!bytes || signal?.aborted || (file.kind === "PDF" && isEncryptedPdf(bytes))) return
          const id = await uploadToClaude(client, file, bytes, signal)
          if (!id) return
          const { count } = await prisma.jackFile.updateMany({ where: { id: file.id, status: "READY", anthropicFileId: null }, data: { anthropicFileId: id } })
          if (count) ids.set(file.id, id)
          // Another request saved one first, or the file went: this copy belongs to nothing
          else await deleteClaudeFiles([id], { client })
        } catch (error) {
          console.error(`[jack] Couldn't put file ${file.id} on Claude Files:`, redactSecrets(errorText(error)))
        }
      })
    )
  }
  return ids
}
