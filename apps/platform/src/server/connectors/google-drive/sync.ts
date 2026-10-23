import { isUnchanged, saveDocument } from "../documents/saving"
import type { DocumentMeta, DocumentStore } from "../documents/store"
import { cleanDocumentName, DOCUMENT_LIMITS, documentReader, documentText, folderPath, type DocumentReader, type DocumentText } from "../documents/text"
import { DriveApiError, FOLDER_TYPE, isProjectLimit, SHORTCUT_TYPE, type DriveChange, type DriveClient, type DriveFile } from "./client"

/**
 * Keeps ExternalDocument current with the club's Drive folder (design §12.7; research/google-drive.md
 * §3f). Only files under the root folder count: the service account can see anything someone shares
 * with it, so every change is checked against the folder tree, and anything outside is ignored (or
 * removed, if it was indexed and has moved out).
 *
 * - The first run walks the whole tree (a backfill); after that the changes feed keeps it current.
 *   Each walk starts by taking the changes feed's position, so nothing that changes during it is missed.
 * - A full walk runs again every week and removes every file it didn't see (the reconcile).
 * - A folder renamed or moved within the tree has its subtree walked again (new paths); a folder that
 *   left the tree (moved out, trashed, unshared) makes the next walk a full one.
 * - Removed and trashed files are marked deleted and lose their text.
 * - A root folder missing for a day (unshared, deleted) has everything from it removed, whatever the
 *   feed reported; the full walk when it's back brings it all back.
 * - One file never stops the sync: a reader that fails or text the database refuses makes it "error",
 *   read again at the next walk. Rate limits and quotas stop the run instead (they're not about the file).
 * - Everything is resumable: the cursor (folders, the walk's queue, the feed's position) is saved after
 *   each page, and work stops at the deadline. A page left halfway is read again: every step is idempotent.
 *
 * The cursor holds ids, names and Drive's page tokens, never a credential.
 */

/** Where the Drive sync is (ConnectorState.cursor) */
export type DriveCursor = {
  /** The root folder the index was built from; a different GOOGLE_DRIVE_FOLDER_ID starts over */
  rootId?: string
  /** The changes feed's position */
  pageToken?: string
  /** When the last full walk finished (ISO) */
  lastWalkAt?: string
  /** Every folder under the root, by id: its name and parent folder */
  folders?: Record<string, DriveFolder>
  walk?: DriveWalk
  /** When the root folder was first found missing (ISO); a full walk runs once it's back */
  rootMissingAt?: string
}

export type DriveFolder = { name: string; parent: string }

/** A walk in progress: the folders left to list (the first one's next page in `pageToken`) */
export type DriveWalk = {
  /** Full: the whole tree, then whatever it didn't see is removed. Partial: one folder's subtree */
  full: boolean
  startedAt: string
  /** A full walk's changes position, taken before it started; the feed carries on from it */
  startToken?: string
  queue: { id: string; names: string[] }[]
  pageToken?: string
  /** A full walk builds the folder list afresh */
  folders?: Record<string, DriveFolder>
}

export type DriveSyncCounts = { indexed: number; unchanged: number; removed: number; ignored: number; folders: number; changes: number }

export type DriveSyncResult = {
  cursor: DriveCursor
  counts: DriveSyncCounts
  /** There's work left (a walk, or more changes): the next run carries on */
  more: boolean
  /** The root folder answered 404 (gone, or no longer shared), or isn't a folder any more */
  rootMissing: boolean
}

export type DriveSyncOptions = {
  client: DriveClient
  rootId: string
  store: DocumentStore
  cursor: DriveCursor | null | undefined
  signal: AbortSignal
  /** Epoch ms: no new file or page is started after it */
  deadline: number
  /** Saves the cursor as work goes (after each page), so a run that dies resumes there */
  saveCursor?: (cursor: DriveCursor) => Promise<void>
  log?: (line: string) => void
  now?: () => Date
  /** How often a full walk reconciles the index (default a week) */
  walkEveryMs?: number
  /** How long the root may be missing before what came from it is removed (default a day) */
  rootGraceMs?: number
}

export const DRIVE_WALK_EVERY_MS = 7 * 86_400_000
/** A brief 404 (a folder moved and shared again) shouldn't empty the index; a day missing does */
export const DRIVE_ROOT_GRACE_MS = 86_400_000

/** Folders the tree may hold; past it the sync stops with an error instead of walking forever */
const MAX_FOLDERS = 5_000
/** Drive's own limit on nesting */
const MAX_DEPTH = 100

/** How Docs, Sheets and Slides are exported (Sheets: the first tab only, Drive's CSV export) */
const EXPORTS: Record<string, { mimeType: string; reader: DocumentReader }> = {
  "application/vnd.google-apps.document": { mimeType: "text/markdown", reader: { kind: "TEXT", contentType: "text/markdown" } },
  "application/vnd.google-apps.spreadsheet": { mimeType: "text/csv", reader: { kind: "CSV", contentType: "text/csv" } },
  "application/vnd.google-apps.presentation": { mimeType: "text/plain", reader: { kind: "TEXT", contentType: "text/plain" } },
}

const WORKSPACE = "application/vnd.google-apps."

/** 403 reasons that mean the service account may not download or export this file (the owner turned downloads off) */
const NO_DOWNLOAD = new Set(["cannotDownloadFile", "cannotExportFile", "insufficientFilePermissions"])

/** A link to open the file in Drive: Drive's own when it's an https Google link, else one built from the id */
export function driveWebUrl(file: Pick<DriveFile, "id" | "webViewLink">): string {
  try {
    const url = new URL(file.webViewLink ?? "")
    if (url.protocol === "https:" && /(^|\.)google\.com$/i.test(url.hostname)) return url.href
  } catch {
    // fall through
  }
  return `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`
}

const isApiError = (error: unknown, status: number) => error instanceof DriveApiError && error.status === status

export async function syncDrive(options: DriveSyncOptions): Promise<DriveSyncResult> {
  const { client, rootId, store, signal, deadline, log = () => {} } = options
  const now = options.now ?? (() => new Date())
  const walkEveryMs = options.walkEveryMs ?? DRIVE_WALK_EVERY_MS
  const rootGraceMs = options.rootGraceMs ?? DRIVE_ROOT_GRACE_MS
  const counts: DriveSyncCounts = { indexed: 0, unchanged: 0, removed: 0, ignored: 0, folders: 0, changes: 0 }
  const timeLeft = () => !signal.aborted && Date.now() < deadline
  const save = async () => options.saveCursor?.(cursor)

  let cursor: DriveCursor = structuredClone(options.cursor ?? {})
  if (cursor.rootId !== rootId) {
    if (cursor.rootId) log("The root folder changed: starting over with a full walk.")
    cursor = { rootId, folders: {} }
  }
  cursor.folders ??= {}
  /** Folders looked up this run that weren't in the list yet (null: not a folder we can see) */
  const lookedUp = new Map<string, DriveFolder | null>()
  let fullWalkDue = false

  // The root first: gone or unshared, nothing is walked, and the changes feed (which then reports
  // its files as removed) still runs, so nothing stays searchable after the folder is gone
  let rootMissing = false
  try {
    const root = await client.getFile(rootId, "id,name,mimeType,trashed", signal)
    rootMissing = root.mimeType !== FOLDER_TYPE || root.trashed === true
  } catch (error) {
    if (!isApiError(error, 404)) throw error
    rootMissing = true
  }

  async function startFullWalk() {
    cursor.walk = { full: true, startedAt: now().toISOString(), startToken: await client.startPageToken(signal), queue: [{ id: rootId, names: [] }], folders: {} }
    fullWalkDue = false
    log(cursor.pageToken ? "Started a full walk (weekly reconcile, or a folder left the tree)." : "Started the first full walk.")
    await save()
  }

  /** A folder's subtree walked again: renamed or moved within the tree, or moved in */
  function walkSubtree(id: string, names: string[]) {
    if (cursor.walk?.full) return
    cursor.walk ??= { full: false, startedAt: now().toISOString(), queue: [] }
    if (!cursor.walk.queue.some((folder) => folder.id === id)) cursor.walk.queue.push({ id, names })
  }

  async function lookUpFolder(id: string): Promise<DriveFolder | null> {
    if (lookedUp.has(id)) return lookedUp.get(id)!
    let folder: DriveFolder | null = null
    try {
      const file = await client.getFile(id, "id,name,mimeType,parents,trashed", signal)
      if (file.mimeType === FOLDER_TYPE && !file.trashed && file.parents?.[0]) folder = { name: cleanDocumentName(file.name), parent: file.parents[0] }
    } catch (error) {
      // 404, or a 403 about the folder itself: not one we can see. A rate limit or quota says nothing
      // about the folder, so the run stops (the next one tries again) instead of removing its files
      if (!isApiError(error, 404) && !(isApiError(error, 403) && !isProjectLimit(error))) throw error
    }
    lookedUp.set(id, folder)
    return folder
  }

  /** The folder names from the root down to `parents[0]`, or null when it isn't under the root */
  async function namesOf(parents: string[] | undefined): Promise<string[] | null> {
    const names: string[] = []
    const found: [string, DriveFolder][] = []
    let id = parents?.[0]
    for (let depth = 0; id && id !== rootId; depth++) {
      if (depth > MAX_DEPTH) return null
      const folder = cursor.folders![id] ?? (await lookUpFolder(id))
      if (!folder) return null
      if (!cursor.folders![id]) found.push([id, folder])
      names.unshift(folder.name)
      id = folder.parent
    }
    if (id !== rootId) return null
    // Folders new since the last walk turn out to be in the tree: remember them
    for (const [folderId, folder] of found) cursor.folders![folderId] = folder
    return names
  }

  async function readText(file: DriveFile): Promise<DocumentText> {
    const exported = EXPORTS[file.mimeType]
    try {
      if (exported) {
        const body = await client.exportFile(file.id, exported.mimeType, DOCUMENT_LIMITS.maxExportBytes, signal)
        return body ? documentText(exported.reader, body) : { text: null, textStatus: "too_large" }
      }
      if (file.mimeType.startsWith(WORKSPACE)) return { text: null, textStatus: "unsupported" }
      const reader = documentReader(file.name, file.mimeType)
      if (!reader) return { text: null, textStatus: "unsupported" }
      if (Number(file.size ?? 0) > DOCUMENT_LIMITS.maxDownloadBytes) return { text: null, textStatus: "too_large" }
      if (file.capabilities?.canDownload === false) return { text: null, textStatus: "restricted" }
      const body = await client.download(file.id, DOCUMENT_LIMITS.maxDownloadBytes, signal)
      return body ? documentText(reader, body) : { text: null, textStatus: "too_large" }
    } catch (error) {
      // Rate limits and quotas (the client retried the rate limits) stop the run: they're not about this file
      if (error instanceof DriveApiError && error.status === 403 && !isProjectLimit(error)) {
        if (error.reason === "exportSizeLimitExceeded") return { text: null, textStatus: "too_large" }
        if (error.reason === "fileNotExportable" || error.reason === "fileNotDownloadable") return { text: null, textStatus: "unsupported" }
        if (NO_DOWNLOAD.has(error.reason)) return { text: null, textStatus: "restricted" }
        // Another 403 about this file (the reason for restricted downloads isn't documented): read again at the next walk
        log(`Drive refused "${cleanDocumentName(file.name)}" (403 ${error.reason || "with no reason"}); it's read again at the next walk.`)
        return { text: null, textStatus: "error" }
      }
      throw error
    }
  }

  async function indexFile(file: DriveFile, names: string[]) {
    const meta: DocumentMeta = {
      externalId: file.id,
      name: cleanDocumentName(file.name),
      path: folderPath(names),
      mimeType: file.mimeType,
      webUrl: driveWebUrl(file),
      modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : now(),
      sizeBytes: file.size ? Number(file.size) : null,
      version: file.version ?? null,
    }
    if (isUnchanged(await store.find(file.id), meta)) {
      // Unchanged; its folder may have been renamed. Touching it also marks it seen by this walk
      await store.touch(meta, now())
      counts.unchanged++
      return
    }
    let text: DocumentText
    try {
      text = await readText(file)
    } catch (error) {
      // Gone between the listing and the read
      if (isApiError(error, 404)) {
        if (await store.remove(file.id, now())) counts.removed++
        return
      }
      // Anything else here is about Drive or the network, not the file: the run stops, and the next one reads this page again
      throw error
    }
    await saveDocument(store, meta, text, now(), log)
    counts.indexed++
  }

  async function removeFile(id: string) {
    if (await store.remove(id, now())) counts.removed++
    else counts.ignored++
  }

  async function applyChange(change: DriveChange) {
    counts.changes++
    const known = cursor.folders![change.fileId]
    if (change.removed || !change.file) {
      // A folder of ours lost: only a full walk finds what was in it
      if (known) {
        delete cursor.folders![change.fileId]
        fullWalkDue = true
      } else await removeFile(change.fileId)
      return
    }
    const file = change.file
    if (file.mimeType === FOLDER_TYPE) {
      const names = file.trashed ? null : await namesOf(file.parents)
      if (names === null) {
        if (known) {
          delete cursor.folders![file.id]
          fullWalkDue = true
        } else counts.ignored++
        return
      }
      const folder = { name: cleanDocumentName(file.name), parent: file.parents![0] }
      cursor.folders![file.id] = folder
      if (!known || known.name !== folder.name || known.parent !== folder.parent) walkSubtree(file.id, [...names, folder.name])
      return
    }
    // Shortcuts point anywhere (often outside the folder): they're never followed or indexed
    if (file.mimeType === SHORTCUT_TYPE) {
      counts.ignored++
      return
    }
    const names = file.trashed ? null : await namesOf(file.parents)
    if (names === null) return removeFile(file.id)
    await indexFile(file, names)
  }

  /** One page of the changes feed; false when the feed is caught up (or time ran out) */
  async function changesPage(): Promise<boolean> {
    const page = await client.changes(cursor.pageToken!, signal)
    for (const change of page.changes ?? []) {
      // Stopping mid-page leaves the token where it was: the page is read again, and every change is idempotent
      if (!timeLeft()) return false
      await applyChange(change)
      if (fullWalkDue && !rootMissing) {
        // The walk supersedes the rest; the feed resumes from the walk's own start token
        await startFullWalk()
        return true
      }
    }
    if (page.nextPageToken) {
      cursor.pageToken = page.nextPageToken
      await save()
      return true
    }
    if (page.newStartPageToken) cursor.pageToken = page.newStartPageToken
    await save()
    return false
  }

  /** One page of the next folder in the walk */
  async function walkPage() {
    const walk = cursor.walk!
    const folder = walk.queue[0]
    if (!folder) return finishWalk()
    let page: Awaited<ReturnType<DriveClient["listChildren"]>>
    try {
      page = await client.listChildren(folder.id, walk.pageToken, signal)
    } catch (error) {
      if (isApiError(error, 404) && folder.id !== rootId) {
        // The folder went away meanwhile; the changes feed reports what was in it
        walk.queue.shift()
        walk.pageToken = undefined
        return save()
      }
      if (isApiError(error, 400) && walk.pageToken) {
        // Listing page tokens last a few hours; start this folder's listing again
        walk.pageToken = undefined
        return save()
      }
      throw error
    }
    const folders = walk.full ? (walk.folders ??= {}) : cursor.folders!
    for (const child of page.files ?? []) {
      if (!timeLeft()) return
      if (child.mimeType === FOLDER_TYPE) {
        if (Object.keys(folders).length >= MAX_FOLDERS) throw new Error(`The Drive folder holds more than ${MAX_FOLDERS} folders; the sync stops here instead of walking forever.`)
        folders[child.id] = { name: cleanDocumentName(child.name), parent: folder.id }
        if (!walk.queue.some((queued) => queued.id === child.id)) walk.queue.push({ id: child.id, names: [...folder.names, child.name] })
        counts.folders++
        continue
      }
      if (child.mimeType === SHORTCUT_TYPE || child.trashed) {
        counts.ignored++
        continue
      }
      await indexFile(child, folder.names)
    }
    if (page.nextPageToken) walk.pageToken = page.nextPageToken
    else {
      walk.queue.shift()
      walk.pageToken = undefined
    }
    await save()
  }

  async function finishWalk() {
    const walk = cursor.walk!
    if (walk.full) {
      const removed = await store.removeUnseen(new Date(walk.startedAt), now())
      counts.removed += removed
      cursor.folders = walk.folders ?? {}
      cursor.pageToken = walk.startToken
      cursor.lastWalkAt = now().toISOString()
      log(`Finished a full walk: ${Object.keys(cursor.folders).length} folders${removed ? `, ${removed} files no longer there removed` : ""}.`)
    }
    cursor.walk = undefined
    await save()
  }

  if (rootMissing) {
    cursor.rootMissingAt ??= now().toISOString()
    log("The root folder is missing (gone, or no longer shared): nothing is walked; the changes feed still removes what left.")
    if (now().getTime() - Date.parse(cursor.rootMissingAt) >= rootGraceMs) {
      // Missing for a day: nothing from it stays searchable, whatever the feed reported (it isn't known to
      // report every file under an unshared folder). The folder list goes too, so the feed can't put
      // anything back, and any walk in progress, so the walk when the folder is back starts from the top
      const removed = await store.removeUnseen(now(), now())
      counts.removed += removed
      cursor.folders = {}
      cursor.walk = undefined
      if (removed) log(`The root folder has been missing since ${cursor.rootMissingAt}: removed the ${removed} documents still indexed from it.`)
      await save()
    }
  } else {
    const walkStale = cursor.lastWalkAt ? now().getTime() - Date.parse(cursor.lastWalkAt) > walkEveryMs : true
    // Back after being missing: what changed meanwhile may not all be in the feed
    if (cursor.rootMissingAt) {
      cursor.rootMissingAt = undefined
      fullWalkDue = true
    }
    if (!cursor.walk?.full && (!cursor.pageToken || walkStale || fullWalkDue)) await startFullWalk()
  }

  while (timeLeft()) {
    if (cursor.walk && !rootMissing) {
      await walkPage()
      continue
    }
    if (cursor.pageToken && (await changesPage())) continue
    // The feed is caught up; a folder it reported may still need walking
    if (cursor.walk && !rootMissing) continue
    break
  }
  if (fullWalkDue && !rootMissing) await startFullWalk()
  const more = Boolean((cursor.walk && !rootMissing) || !timeLeft())
  return { cursor, counts, more, rootMissing }
}
