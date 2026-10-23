import { serviceBaseUrl } from "../base-url"
import { readCapped, sleep } from "../documents/bytes"
import type { ConnectorEnv } from "../types"
import { googleTokenSource, type ServiceAccount } from "./auth"

/**
 * A read-only Google Drive v3 client (research/google-drive.md §3), plain fetch against
 * serviceBaseUrl("google-drive", …) so JACK_FAKES points it at the fake. Every call has a timeout (kept
 * when the caller passes a signal), backs off on Google's rate limits and server errors, and signs in
 * again once on a 401. Errors carry the status, Google's reason and the path, never the token.
 */

export const DRIVE_API_URL = "https://www.googleapis.com"
export const DRIVE_TIMEOUT_MS = 20_000
/** Exports and downloads move up to 20 MB */
export const DRIVE_TRANSFER_TIMEOUT_MS = 60_000
/** Tries per call, the first included */
const MAX_ATTEMPTS = 4
/** The longest one back-off waits */
const MAX_BACKOFF_MS = 32_000

export const FOLDER_TYPE = "application/vnd.google-apps.folder"
export const SHORTCUT_TYPE = "application/vnd.google-apps.shortcut"

/** The fields every listing and change asks for. Without `fields` Drive returns only id, name and type */
export const DRIVE_FILE_FIELDS = "id,name,mimeType,parents,modifiedTime,version,size,webViewLink,trashed,capabilities/canDownload"

export type DriveFile = {
  id: string
  name: string
  mimeType: string
  parents?: string[]
  modifiedTime?: string
  /** int64 as a string; goes up with every change */
  version?: string
  /** Bytes, as a string; absent for Google Docs, Sheets and Slides */
  size?: string
  webViewLink?: string
  trashed?: boolean
  capabilities?: { canDownload?: boolean }
}

export type DriveChange = { fileId: string; removed?: boolean; time?: string; changeType?: string; file?: DriveFile }

export class DriveApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly path: string,
  ) {
    super(`Google Drive answered ${status}${reason ? ` (${reason})` : ""} on ${path}`)
    this.name = "DriveApiError"
  }
}

/** Reasons Google gives for a 403 that clear up with a wait */
const RATE_LIMITED = new Set(["rateLimitExceeded", "userRateLimitExceeded"])

function retryable(status: number, reason: string): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || (status === 403 && RATE_LIMITED.has(reason))
}

/** 403 reasons about our project (rate limits, quotas, the API switched off or blocked), not about one file */
const PROJECT_LIMITS = new Set([...RATE_LIMITED, "quotaExceeded", "dailyLimitExceeded", "dailyLimitExceededUnreg", "accessNotConfigured", "SERVICE_DISABLED", "domainPolicy"])

/**
 * Google said no because of a rate limit, a quota or the project's setup (still failing after the
 * client's tries), so it says nothing about the file: a sync stops and tries again next run, instead of
 * taking it as "no access" and removing or flagging files
 */
export function isProjectLimit(error: unknown): boolean {
  return error instanceof DriveApiError && (error.status === 429 || (error.status === 403 && PROJECT_LIMITS.has(error.reason)))
}

/** Google's reason for an error (`error.errors[0].reason`, else `error.status`), from at most 16 KB of the body */
async function errorReason(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).slice(0, 16_384)
  try {
    const body = JSON.parse(text) as { error?: { errors?: { reason?: unknown }[]; status?: unknown } | string }
    const error = body.error
    if (typeof error === "string") return error.slice(0, 80)
    const reason = error?.errors?.[0]?.reason ?? error?.status
    return typeof reason === "string" ? reason.slice(0, 80) : ""
  } catch {
    return ""
  }
}

/** A query string literal: `'` and `\` escaped */
export function driveQueryString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

export type DriveClientOptions = {
  env?: ConnectorEnv
  /** The first back-off; it doubles on each retry (tests pass 0) */
  retryDelayMs?: number
}

export function driveClient(account: ServiceAccount, { env = process.env, retryDelayMs = 1_000 }: DriveClientOptions = {}) {
  const base = serviceBaseUrl("google-drive", DRIVE_API_URL, env)
  const tokens = googleTokenSource(account, env)

  async function send(path: string, query: Record<string, string | undefined>, { signal, timeoutMs = DRIVE_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Response> {
    const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined))
    const url = `${base}${path}${params.size ? `?${params}` : ""}`
    let signedInAgain = false
    for (let attempt = 1; ; attempt++) {
      const token = await tokens.token(signal)
      const timeout = AbortSignal.timeout(timeoutMs)
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      if (response.ok) return response
      const reason = await errorReason(response)
      if (response.status === 401 && !signedInAgain) {
        tokens.invalidate()
        signedInAgain = true
        continue
      }
      if (retryable(response.status, reason) && attempt < MAX_ATTEMPTS) {
        const after = Number(response.headers.get("retry-after"))
        const wait = Number.isFinite(after) && after > 0 ? after * 1000 : retryDelayMs * 2 ** (attempt - 1) + Math.random() * Math.min(retryDelayMs, 1000)
        await sleep(Math.min(wait, MAX_BACKOFF_MS), signal)
        continue
      }
      throw new DriveApiError(response.status, reason, path)
    }
  }

  const json = async <T>(path: string, query: Record<string, string | undefined>, signal?: AbortSignal) => (await (await send(path, query, { signal })).json()) as T
  const file = (id: string) => `/drive/v3/files/${encodeURIComponent(id)}`
  const allDrives = { supportsAllDrives: "true" }

  return {
    /** One file's metadata. 404 when it's gone or not shared with us */
    getFile: (id: string, fields: string = DRIVE_FILE_FIELDS, signal?: AbortSignal) => json<DriveFile>(file(id), { fields, ...allDrives }, signal),

    /** One page of a folder's direct children (Drive has no recursive listing), trashed ones left out */
    listChildren: (folderId: string, pageToken?: string, signal?: AbortSignal) =>
      json<{ files?: DriveFile[]; nextPageToken?: string }>(
        "/drive/v3/files",
        {
          q: `${driveQueryString(folderId)} in parents and trashed = false`,
          fields: `nextPageToken,incompleteSearch,files(${DRIVE_FILE_FIELDS})`,
          pageSize: "1000",
          pageToken,
          includeItemsFromAllDrives: "true",
          ...allDrives,
        },
        signal,
      ),

    /** Where the changes feed starts now; taken before a full walk so nothing changed during it is missed */
    async startPageToken(signal?: AbortSignal): Promise<string> {
      const body = await json<{ startPageToken?: string }>("/drive/v3/changes/startPageToken", allDrives, signal)
      if (!body.startPageToken) throw new DriveApiError(200, "noStartPageToken", "/drive/v3/changes/startPageToken")
      return body.startPageToken
    },

    /** One page of changes since `pageToken`, oldest first. The last page has `newStartPageToken` */
    changes: (pageToken: string, signal?: AbortSignal) =>
      json<{ changes?: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>(
        "/drive/v3/changes",
        {
          pageToken,
          pageSize: "1000",
          fields: `nextPageToken,newStartPageToken,changes(fileId,removed,time,changeType,file(${DRIVE_FILE_FIELDS}))`,
          includeRemoved: "true",
          includeItemsFromAllDrives: "true",
          ...allDrives,
        },
        signal,
      ),

    /** A Google Doc, Sheet or Slides deck exported as `mimeType`; null when it's over `maxBytes` */
    async exportFile(id: string, mimeType: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
      const response = await send(`${file(id)}/export`, { mimeType }, { signal, timeoutMs: DRIVE_TRANSFER_TIMEOUT_MS })
      return readCapped(response, maxBytes)
    },

    /** A stored file's bytes; null when it's over `maxBytes` (it stops reading as soon as it's over) */
    async download(id: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
      const response = await send(file(id), { alt: "media", ...allDrives }, { signal, timeoutMs: DRIVE_TRANSFER_TIMEOUT_MS })
      return readCapped(response, maxBytes)
    },
  }
}

export type DriveClient = ReturnType<typeof driveClient>
