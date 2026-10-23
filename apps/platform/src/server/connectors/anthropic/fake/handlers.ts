import type { FakeService } from "../../fakes/types"

/** A key the fake turns down, like a deleted or expired one (401 authentication_error) */
export const ANTHROPIC_FAKE_BAD_KEY = "fake-bad-key"

/** The largest upload the Files API takes */
const MAX_FILE_BYTES = 500 * 1024 * 1024
const MIN_EXPIRY_S = 3_600
const MAX_EXPIRY_S = 7_776_000
/** Characters a file name can't have, besides control characters */
const BAD_NAME = /[<>:"|?*\\/]/

type StoredFile = {
  id: string
  filename: string
  mimeType: string
  bytes: Uint8Array
  createdAt: Date
  expiresAt: Date | null
}

/**
 * The Claude Files API (docs/jack-2/research/anthropic-tools.md §3d and §7), mounted at /anthropic:
 * upload (multipart, field `file`), list (paged with `limit` and `page`, or `ids[]`), metadata, delete,
 * and content (400 for uploads, as the API answers). Gone files (deleted or expired) are 404s and drop
 * out of lists. Ids carry the kind the way fakeClaude's stand-ins do (`file_fake_pdf_1`,
 * `file_fake_image_2`), so a request that puts one in the wrong block fails there like the real API.
 *
 * Errors use the API's shape: `{ type: "error", error: { type, message } }`. A missing key, or
 * ANTHROPIC_FAKE_BAD_KEY, gets 401. Test hook: `POST /_fake/expire/:id` makes a file expire now.
 */
export const anthropicFake: FakeService = {
  id: "anthropic",
  create() {
    const files = new Map<string, StoredFile>()
    let next = 0

    const error = (status: number, type: string, message: string) => Response.json({ type: "error", error: { type, message }, request_id: `req_fake_${++next}` }, { status })
    const unauthorized = (request: Request) => {
      const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
      if (!key) return error(401, "authentication_error", "x-api-key header is required")
      if (key === ANTHROPIC_FAKE_BAD_KEY) return error(401, "authentication_error", "invalid x-api-key")
      return null
    }
    const live = (id: string) => {
      const file = files.get(id)
      if (!file) return null
      if (file.expiresAt && file.expiresAt.getTime() <= Date.now()) {
        files.delete(id)
        return null
      }
      return file
    }
    const notFound = (id: string) => error(404, "not_found_error", `File \`${id}\` not found.`)
    const metadata = (file: StoredFile) => ({
      id: file.id,
      type: "file",
      filename: file.filename,
      mime_type: file.mimeType,
      size_bytes: file.bytes.length,
      created_at: file.createdAt.toISOString(),
      downloadable: false,
      expires_at: file.expiresAt?.toISOString() ?? null,
    })
    const kindOf = (mimeType: string) => (mimeType === "application/pdf" ? "pdf" : mimeType.startsWith("image/") ? "image" : "file")

    return [
      {
        method: "POST",
        path: "/v1/files",
        async handle(request) {
          const denied = unauthorized(request)
          if (denied) return denied
          const form = await request.formData().catch(() => null)
          const file = form?.get("file")
          if (!form || !(file instanceof Blob)) return error(400, "invalid_request_error", "file: Field required")
          const filename = (file instanceof File ? file.name : "").split(/[\\/]/).pop() ?? ""
          // eslint-disable-next-line no-control-regex
          if (!filename || filename.length > 255 || BAD_NAME.test(filename) || /[\u0000-\u001f\u007f]/.test(filename)) {
            return error(400, "invalid_request_error", "Invalid filename")
          }
          if (file.size > MAX_FILE_BYTES) return error(413, "request_too_large", "File exceeds the maximum size of 500 MB")
          const expiry = form.get("expires_in_seconds")
          const seconds = expiry === null ? null : Number(expiry)
          if (seconds !== null && !(Number.isInteger(seconds) && seconds >= MIN_EXPIRY_S && seconds <= MAX_EXPIRY_S)) {
            return error(400, "invalid_request_error", `expires_in_seconds must be between ${MIN_EXPIRY_S} and ${MAX_EXPIRY_S}`)
          }
          const mimeType = (file.type || "application/octet-stream").split(";")[0].trim().toLowerCase()
          const now = new Date()
          const stored: StoredFile = {
            id: `file_fake_${kindOf(mimeType)}_${++next}`,
            filename,
            mimeType,
            bytes: new Uint8Array(await file.arrayBuffer()),
            createdAt: now,
            expiresAt: seconds === null ? null : new Date(now.getTime() + seconds * 1000),
          }
          files.set(stored.id, stored)
          return Response.json(metadata(stored))
        },
      },
      {
        method: "GET",
        path: "/v1/files",
        handle(request) {
          const denied = unauthorized(request)
          if (denied) return denied
          const query = new URL(request.url).searchParams
          const ids = query.getAll("ids[]")
          if (ids.length) {
            if (query.has("limit") || query.has("page")) return error(400, "invalid_request_error", "ids can't be combined with limit or page")
            const unique = [...new Set(ids)]
            if (unique.length > 100) return error(400, "invalid_request_error", "ids: at most 100")
            const found = unique.map(live).filter((file): file is StoredFile => file !== null)
            return Response.json({ data: found.map(metadata), next_page: null })
          }
          const limit = Number(query.get("limit") ?? 20)
          if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return error(400, "invalid_request_error", "limit must be between 1 and 1000")
          // Newest first; the page cursor is where the next page starts
          const all = [...files.keys()].filter((id) => live(id)).reverse()
          const start = Number(query.get("page") ?? 0) || 0
          const page = all.slice(start, start + limit)
          return Response.json({ data: page.map((id) => metadata(files.get(id)!)), next_page: start + limit < all.length ? String(start + limit) : null })
        },
      },
      {
        method: "GET",
        path: "/v1/files/:id",
        handle(request, { params }) {
          const denied = unauthorized(request)
          if (denied) return denied
          const file = live(params.id)
          return file ? Response.json(metadata(file)) : notFound(params.id)
        },
      },
      {
        method: "DELETE",
        path: "/v1/files/:id",
        handle(request, { params }) {
          const denied = unauthorized(request)
          if (denied) return denied
          if (!live(params.id)) return notFound(params.id)
          files.delete(params.id)
          return Response.json({ id: params.id, type: "file_deleted" })
        },
      },
      {
        method: "GET",
        path: "/v1/files/:id/content",
        handle(request, { params }) {
          const denied = unauthorized(request)
          if (denied) return denied
          if (!live(params.id)) return notFound(params.id)
          return error(400, "invalid_request_error", `File \`${params.id}\` is not downloadable.`)
        },
      },
      {
        method: "POST",
        path: "/_fake/expire/:id",
        handle(_request, { params }) {
          const file = files.get(params.id)
          if (!file) return notFound(params.id)
          file.expiresAt = new Date(Date.now() - 1)
          return Response.json({ ok: true })
        },
      },
    ]
  },
}
