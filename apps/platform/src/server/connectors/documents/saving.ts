import type { DocumentMeta, DocumentStore, StoredDocument } from "./store"
import type { DocumentText } from "./text"

/**
 * The rules both document syncs (Drive, SharePoint) follow when they meet a file: whether to read it
 * again, and how its text is saved so that one file never stops a sync.
 */

/**
 * Statuses a passing problem can cause (a reader that timed out under load, a permission glitch), so a
 * file with one is read again whenever a sync meets it (the weekly walk at the latest), even unchanged
 */
const READ_AGAIN = new Set<string>(["error", "restricted"])

/** Whether a file the sync meets keeps what's stored: the same version, not removed, and read cleanly */
export function isUnchanged(existing: StoredDocument | null, meta: DocumentMeta): boolean {
  return Boolean(existing && !existing.deletedAt && meta.version !== null && existing.version === meta.version && !READ_AGAIN.has(existing.textStatus))
}

/**
 * Saves a file with its text. When the database refuses the text itself, the file is kept without it
 * ("error", so it's read again next time) and the sync goes on. A second refusal (the database is down)
 * is a real failure. The log never quotes the error, which may hold the text.
 */
export async function saveDocument(store: DocumentStore, meta: DocumentMeta, text: DocumentText, at: Date, log: (line: string) => void): Promise<void> {
  try {
    await store.save(meta, text, at)
  } catch (error) {
    if (text.text === null) throw error
    log(`Kept "${meta.name}" without its text: the database refused it.`)
    await store.save(meta, { text: null, textStatus: "error" }, at)
  }
}
