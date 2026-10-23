import type { JackRegisterResult } from "./files"

/**
 * The browser side of attaching a file in a room (G5, design §5): the upload itself and the
 * register call that follows. Plain functions, so the composer's hook and the tests share them.
 */

export type UploadOutcome = { ok: true } | { ok: false; error: string; aborted?: true }

/** The parts of XMLHttpRequest the upload uses (tests pass a fake) */
export type UploadXhr = Pick<XMLHttpRequest, "open" | "setRequestHeader" | "send" | "abort" | "status" | "responseText" | "timeout"> & {
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  ontimeout: (() => void) | null
  onabort: (() => void) | null
}

type UploadOptions = {
  /** 0 to 1 as the bytes go out */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** Supabase's public anon key, sent as `apikey` like supabase-js does; not needed for the local route */
  apikey?: string
  makeXhr?: () => UploadXhr
}

/** Ten minutes: a 25 MB file on a slow connection */
const UPLOAD_TIMEOUT_MS = 10 * 60_000

/**
 * Uploads a file to a signed upload URL with the request supabase-js's uploadToSignedUrl sends
 * (@supabase/storage-js 2.98: PUT, the file in a form beside `cacheControl`, `x-upsert: false`), but
 * through XMLHttpRequest, because fetch can't report upload progress. The file goes up as
 * `contentType`, the type the server checks it against, whatever the browser guessed for it.
 */
export function uploadToSignedUrl(url: string, file: Blob, contentType: string, { onProgress, signal, apikey, makeXhr = () => new XMLHttpRequest() as UploadXhr }: UploadOptions = {}): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, error: "Removed", aborted: true })
    const xhr = makeXhr()
    const form = new FormData()
    form.append("cacheControl", "3600")
    form.append("", new Blob([file], { type: contentType }))
    const done = (outcome: UploadOutcome) => {
      signal?.removeEventListener("abort", stop)
      resolve(outcome)
    }
    const stop = () => xhr.abort()
    signal?.addEventListener("abort", stop)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total))
    }
    xhr.onload = () => done(xhr.status >= 200 && xhr.status < 300 ? { ok: true } : { ok: false, error: uploadError(xhr.status, xhr.responseText) })
    xhr.onerror = () => done({ ok: false, error: "The upload didn't go through. Check your connection and try again." })
    xhr.ontimeout = () => done({ ok: false, error: "The upload took too long. Try again on a faster connection." })
    xhr.onabort = () => done({ ok: false, error: "Removed", aborted: true })
    xhr.open("PUT", url)
    xhr.timeout = UPLOAD_TIMEOUT_MS
    xhr.setRequestHeader("x-upsert", "false")
    if (apikey) xhr.setRequestHeader("apikey", apikey)
    xhr.send(form)
  })
}

/** What Supabase Storage's error says, for an officer. It answers {statusCode, error, message} JSON (usually with HTTP 400) */
export function uploadError(status: number, responseText: string): string {
  let body: { statusCode?: string; error?: string; message?: string } = {}
  try {
    body = JSON.parse(responseText) as typeof body
  } catch {}
  const code = body.statusCode ?? String(status)
  const words = `${body.error ?? ""} ${body.message ?? ""}`.toLowerCase()
  if (code === "413" || status === 413 || words.includes("too large")) return "This file is over the storage size limit."
  if (code === "415" || words.includes("mime type")) return "Storage doesn't take this type of file."
  if (code === "409" || words.includes("duplicate") || words.includes("already")) return "This file was already uploaded. Remove it and attach it again."
  if (words.includes("signature") || words.includes("expired") || words.includes("jwt")) return "The upload link expired. Remove the file and attach it again."
  if (status === 403 || code === "403") return "The upload was refused. Remove the file and attach it again."
  return `The upload failed (${code}). Remove the file and try again.`
}

/** Asks the server to check an uploaded file and get it ready (POST /api/admin/jack/files/[id]/register) */
export async function registerUpload(fileId: string, fetcher: typeof fetch = fetch): Promise<JackRegisterResult> {
  try {
    const response = await fetcher(`/api/admin/jack/files/${encodeURIComponent(fileId)}/register`, { method: "POST" })
    const body = (await response.json().catch(() => null)) as JackRegisterResult | null
    if (body && typeof body === "object" && "ok" in body) return body
    return { ok: false, error: `Couldn't check the file (${response.status}). Remove it and attach it again.` }
  } catch {
    return { ok: false, error: "Couldn't reach the server to check the file. Check your connection, then attach it again." }
  }
}
