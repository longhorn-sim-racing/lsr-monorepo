import { isUnchanged, saveDocument } from "../documents/saving"
import type { DocumentMeta, DocumentStore } from "../documents/store"
import { cleanDocumentName, DOCUMENT_LIMITS, documentReader, documentText, folderPath, type DocumentText } from "../documents/text"
import { GraphApiError, type GraphClient } from "../microsoft/graph"

/**
 * Keeps ExternalDocument current with the club's SharePoint document library (design §12.8;
 * research/microsoft-graph.md §3b-3c), through Graph's drive delta. The same text pipeline as Drive.
 *
 * - The first run enumerates the whole library (a delta without a token); later runs follow the
 *   stored delta link. A full enumeration runs again every week, then removes what it didn't see:
 *   Graph's delta doesn't always list a deleted folder's children, and paths of files under a renamed
 *   folder only update then.
 * - Items with a `deleted` facet are marked removed and lose their text.
 * - Delta items have no path, so a file's folder comes from its parent folder (one GET per folder per run).
 *   A parent that's gone by then (404) means the file went with it; one we may not read (403) gives no path.
 * - 410 Gone means "enumerate again": a full enumeration starts over.
 * - One file never stops the sync: a reader that fails or text the database refuses makes it "error",
 *   read again at the next enumeration.
 * - Resumable: the cursor (the delta link, or how far an enumeration got) is saved after each page.
 *
 * The cursor holds Graph's links (they carry a sync position, never a credential).
 */

export type SharePointCursor = {
  /** The library the index was built from; another MS_DRIVE_ID starts over */
  driveId?: string
  /** Where the next incremental run starts */
  deltaLink?: string
  /** An incremental run that stopped part way: its next page */
  pendingLink?: string
  /** A full enumeration in progress */
  enumeration?: { startedAt: string; nextLink?: string }
  /** When the last full enumeration finished (ISO) */
  lastFullAt?: string
}

type DriveItem = {
  id: string
  name?: string
  eTag?: string
  cTag?: string
  lastModifiedDateTime?: string
  size?: number
  webUrl?: string
  parentReference?: { driveId?: string; id?: string; path?: string }
  file?: { mimeType?: string }
  folder?: { childCount?: number }
  root?: object
  package?: object
  deleted?: { state?: string }
}

export type SharePointSyncCounts = { indexed: number; unchanged: number; removed: number; folders: number; ignored: number }

export type SharePointSyncOptions = {
  graph: GraphClient
  driveId: string
  store: DocumentStore
  cursor: SharePointCursor | null | undefined
  signal: AbortSignal
  deadline: number
  saveCursor?: (cursor: SharePointCursor) => Promise<void>
  log?: (line: string) => void
  now?: () => Date
  /** How often a full enumeration reconciles (default a week) */
  fullEveryMs?: number
}

export const SHAREPOINT_FULL_EVERY_MS = 7 * 86_400_000

/** "/drives/b!x/root:/Sponsors/2026" → ["Sponsors", "2026"] */
export function namesFromGraphPath(path: string | undefined): string[] {
  const at = path?.indexOf("root:") ?? -1
  if (!path || at < 0) return []
  return path
    .slice(at + 5)
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
}

/** SharePoint's own https link, or none */
function safeWebUrl(url: string | undefined): string {
  try {
    const parsed = new URL(url ?? "")
    return parsed.protocol === "https:" ? parsed.href : ""
  } catch {
    return ""
  }
}

export async function syncSharePoint(options: SharePointSyncOptions): Promise<{ cursor: SharePointCursor; counts: SharePointSyncCounts; more: boolean }> {
  const { graph, driveId, store, signal, deadline, log = () => {} } = options
  const now = options.now ?? (() => new Date())
  const fullEveryMs = options.fullEveryMs ?? SHAREPOINT_FULL_EVERY_MS
  const counts: SharePointSyncCounts = { indexed: 0, unchanged: 0, removed: 0, folders: 0, ignored: 0 }
  const timeLeft = () => !signal.aborted && Date.now() < deadline
  const drive = `/drives/${encodeURIComponent(driveId)}`

  let cursor: SharePointCursor = structuredClone(options.cursor ?? {})
  if (cursor.driveId !== driveId) {
    if (cursor.driveId) log("The library changed: enumerating it from the start.")
    cursor = { driveId }
  }
  const save = async () => options.saveCursor?.(cursor)
  /** Folder names by folder id, this run (null: the folder is gone) */
  const folders = new Map<string, string[] | null>()

  /** The folder names down to `parentId`; null when that folder was deleted after the delta page listed the file */
  async function folderNames(parentId: string | undefined): Promise<string[] | null> {
    if (!parentId) return []
    const cached = folders.get(parentId)
    if (cached !== undefined) return cached
    let names: string[] | null
    try {
      const folder = await graph.get<DriveItem>(`${drive}/items/${encodeURIComponent(parentId)}?$select=id,name,parentReference,root`, { signal })
      names = folder.root ? [] : [...namesFromGraphPath(folder.parentReference?.path), folder.name ?? ""]
    } catch (error) {
      if (!(error instanceof GraphApiError) || (error.status !== 404 && error.status !== 403)) throw error
      // 404: deleted with its files (the delta reports them too); 403: a folder we may not read, so no path
      names = error.status === 404 ? null : []
    }
    folders.set(parentId, names)
    return names
  }

  async function readText(item: DriveItem): Promise<DocumentText> {
    const reader = documentReader(item.name ?? "", item.file?.mimeType ?? "")
    if (!reader) return { text: null, textStatus: "unsupported" }
    if ((item.size ?? 0) > DOCUMENT_LIMITS.maxDownloadBytes) return { text: null, textStatus: "too_large" }
    try {
      const body = await graph.download(driveId, item.id, DOCUMENT_LIMITS.maxDownloadBytes, signal)
      return body ? documentText(reader, body) : { text: null, textStatus: "too_large" }
    } catch (error) {
      // A file whose own permissions leave the app out
      if (error instanceof GraphApiError && error.status === 403) return { text: null, textStatus: "restricted" }
      throw error
    }
  }

  async function apply(item: DriveItem) {
    const externalId = `${driveId}!${item.id}`
    if (item.deleted) {
      if (await store.remove(externalId, now())) counts.removed++
      else counts.ignored++
      return
    }
    if (item.root || item.folder) {
      counts.folders++
      return
    }
    // OneNote notebooks and other packages have no file to read
    if (!item.file) {
      counts.ignored++
      return
    }
    const names = await folderNames(item.parentReference?.id)
    if (names === null) {
      if (await store.remove(externalId, now())) counts.removed++
      else counts.ignored++
      return
    }
    const meta: DocumentMeta = {
      externalId,
      driveId,
      name: cleanDocumentName(item.name ?? ""),
      path: folderPath(names),
      mimeType: item.file.mimeType ?? "application/octet-stream",
      webUrl: safeWebUrl(item.webUrl),
      modifiedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : now(),
      sizeBytes: typeof item.size === "number" ? item.size : null,
      version: item.eTag ?? item.cTag ?? null,
    }
    if (isUnchanged(await store.find(externalId), meta)) {
      await store.touch(meta, now())
      counts.unchanged++
      return
    }
    let text: DocumentText
    try {
      text = await readText(item)
    } catch (error) {
      if (error instanceof GraphApiError && error.status === 404) {
        if (await store.remove(externalId, now())) counts.removed++
        return
      }
      // Anything else here is about Graph or the network, not the file: the run stops, and the next one reads this page again
      throw error
    }
    await saveDocument(store, meta, text, now(), log)
    counts.indexed++
  }

  /** Reads one page; `resync` when Graph answered 410 Gone (the delta link is no longer valid) */
  async function page(link: string): Promise<{ value: DriveItem[]; nextLink: string | null; deltaLink: string | null } | { resync: true }> {
    try {
      return await graph.page<DriveItem>(link, { signal })
    } catch (error) {
      if (error instanceof GraphApiError && error.status === 410) return { resync: true }
      throw error
    }
  }

  function startEnumeration() {
    cursor.enumeration = { startedAt: now().toISOString() }
    cursor.pendingLink = undefined
  }

  const stale = !cursor.lastFullAt || now().getTime() - Date.parse(cursor.lastFullAt) > fullEveryMs
  if (!cursor.enumeration && (!cursor.deltaLink || stale)) {
    startEnumeration()
    log(cursor.deltaLink ? "Started the weekly full enumeration." : "Started the first full enumeration.")
  }

  let resyncs = 0
  while (timeLeft()) {
    const enumeration = cursor.enumeration
    const link = enumeration ? (enumeration.nextLink ?? `${drive}/root/delta`) : (cursor.pendingLink ?? cursor.deltaLink)
    if (!link) break
    const result = await page(link)
    if ("resync" in result) {
      // Graph's Location re-lists everything too; a delta without a token does the same, from our own base
      if (++resyncs > 2) throw new Error("Microsoft Graph keeps answering 410 Gone to the library's delta")
      log("Graph asked for a fresh enumeration (410).")
      startEnumeration()
      await save()
      continue
    }
    let stopped = false
    for (const item of result.value) {
      // Stopping mid-page keeps the page's link: it's read again, and every item is idempotent
      if (!timeLeft()) {
        stopped = true
        break
      }
      await apply(item)
    }
    if (stopped) break
    if (result.nextLink) {
      if (enumeration) enumeration.nextLink = result.nextLink
      else cursor.pendingLink = result.nextLink
      await save()
      continue
    }
    if (enumeration) {
      const removed = await store.removeUnseen(new Date(enumeration.startedAt), now())
      counts.removed += removed
      cursor.lastFullAt = now().toISOString()
      cursor.enumeration = undefined
      log(`Finished a full enumeration${removed ? `; ${removed} files no longer there removed` : ""}.`)
    }
    cursor.pendingLink = undefined
    if (result.deltaLink) cursor.deltaLink = result.deltaLink
    await save()
    break
  }
  return { cursor, counts, more: Boolean(cursor.enumeration || cursor.pendingLink) }
}
