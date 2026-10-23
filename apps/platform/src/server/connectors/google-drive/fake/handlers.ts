import { createPublicKey, verify } from "node:crypto"
import { strToU8 } from "fflate"
import type { FakeRoute, FakeService } from "../../fakes/types"
import { DRIVE_SCOPE, GOOGLE_TOKEN_AUDIENCE, JWT_BEARER_GRANT } from "../auth"
import { DOC, DRIVE_FAKE_ROOT_ID, DRIVE_FAKE_SA_EMAIL, driveFixtures, fakePptx, FOLDER, PPTX, SHEET, SLIDES, type FakeDriveItem } from "./fixtures"
import { FakeQueryError, parseDriveQuery, parseFields, project } from "./query"

/**
 * The Google Drive fake, mounted at /google-drive (research/google-drive.md §7): the token endpoint
 * (checks the JWT's claims, and its RS256 signature once a test registers the public key), Drive v3's
 * files.list (a `q` parser for the subset we send, `fields` projection, paging), files.get (metadata,
 * alt=media with Range), files.export (canned exports, 10 MB refusal), and the changes feed (an
 * append-only log: removed entries carry no file). Test hooks under /_fake: mutate the folder, fail the
 * next calls, expire every token, set the public key or a smaller page size.
 */

const TOKEN_LIFETIME_S = 3600
const WORKSPACE = "application/vnd.google-apps."

/** Export pairs a Workspace type allows (a few more exist; these are what the fake answers) */
const EXPORTS: Record<string, string[]> = {
  [DOC]: ["text/markdown", "text/plain", "text/html", "application/pdf"],
  [SHEET]: ["text/csv", "application/pdf"],
  [SLIDES]: ["text/plain", "application/pdf"],
}

/** An injected error; with `path`, only calls to that API path (e.g. "/drive/v3/files/fx-sponsors") get it */
type Failure = { status: number; reason: string; remaining: number; retryAfter?: number; path?: string }

const driveError = (status: number, reason: string, message: string, headers?: HeadersInit) =>
  Response.json({ error: { code: status, message, errors: [{ domain: "global", reason, message }] } }, { status, headers })

const notFound = (id: string) => driveError(404, "notFound", `File not found: ${id}.`)

function webViewLink(item: FakeDriveItem): string {
  if (item.mimeType === DOC) return `https://docs.google.com/document/d/${item.id}/edit?usp=drivesdk`
  if (item.mimeType === SHEET) return `https://docs.google.com/spreadsheets/d/${item.id}/edit?usp=drivesdk`
  if (item.mimeType === SLIDES) return `https://docs.google.com/presentation/d/${item.id}/edit?usp=drivesdk`
  if (item.mimeType === FOLDER) return `https://drive.google.com/drive/folders/${item.id}`
  return `https://drive.google.com/file/d/${item.id}/view?usp=drivesdk`
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signed: string; signature: Buffer } | null {
  const parts = jwt.split(".")
  if (parts.length !== 3) return null
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
      claims: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
      signed: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], "base64url"),
    }
  } catch {
    return null
  }
}

export const googleDriveFake: FakeService = {
  id: "google-drive",
  create(): FakeRoute[] {
    const items = new Map(driveFixtures().map((item) => [item.id, item]))
    const bytesCache = new Map<string, Uint8Array>()
    /** The changes feed: one entry per change; a page token is an index into it */
    const log: { fileId: string; time: string }[] = []
    const tokens = new Set<string>()
    let failures: Failure[] = []
    let publicKey: string | null = null
    let maxPageSize = 1000
    let nextToken = 1

    const bytesOf = async (item: FakeDriveItem) => {
      if (!item.bytes) return null
      let bytes = bytesCache.get(item.id)
      if (!bytes) {
        bytes = await item.bytes()
        bytesCache.set(item.id, bytes)
      }
      return bytes
    }

    /** Whether the service account can see it: shared itself, or under a shared folder */
    const visible = (item: FakeDriveItem | undefined): boolean => {
      for (let current = item, depth = 0; current && depth < 200; current = current.parent ? items.get(current.parent) : undefined, depth++) {
        if (current.shared) return true
      }
      return false
    }
    const descendants = (id: string): FakeDriveItem[] => {
      const out: FakeDriveItem[] = []
      for (const child of items.values()) if (child.parent === id) out.push(child, ...descendants(child.id))
      return out
    }

    async function resource(item: FakeDriveItem) {
      const bytes = await bytesOf(item)
      return {
        kind: "drive#file",
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        parents: item.parent ? [item.parent] : [],
        modifiedTime: item.modifiedTime,
        version: String(item.version),
        trashed: item.trashed ?? false,
        webViewLink: webViewLink(item),
        capabilities: { canDownload: item.canDownload !== false },
        ...(bytes ? { size: String(bytes.length) } : {}),
        ...(item.shortcutTarget ? { shortcutDetails: { targetId: item.shortcutTarget, targetMimeType: items.get(item.shortcutTarget)?.mimeType } } : {}),
      }
    }

    const record = (...changed: FakeDriveItem[] | string[]) => {
      const time = new Date().toISOString()
      for (const entry of changed) log.push({ fileId: typeof entry === "string" ? entry : entry.id, time })
    }
    const bump = (item: FakeDriveItem) => {
      item.version++
      item.modifiedTime = new Date().toISOString()
    }

    const authorized = (request: Request) => {
      const header = request.headers.get("authorization") ?? ""
      return header.startsWith("Bearer ") && tokens.has(header.slice(7))
    }
    const unauthorized = () =>
      Response.json(
        { error: { code: 401, message: "Request had invalid authentication credentials.", errors: [{ domain: "global", reason: "authError", message: "Invalid Credentials", location: "Authorization", locationType: "header" }], status: "UNAUTHENTICATED" } },
        { status: 401 },
      )

    /** Auth and injected failures for the Drive API routes; null to go on */
    function gate(request: Request): Response | null {
      if (!authorized(request)) return unauthorized()
      const pathname = new URL(request.url).pathname
      const failure = failures.find((one) => !one.path || pathname.endsWith(one.path))
      if (failure) {
        failure.remaining--
        if (failure.remaining <= 0) failures = failures.filter((one) => one !== failure)
        return driveError(failure.status, failure.reason, `Injected ${failure.reason}`, failure.retryAfter !== undefined ? { "retry-after": String(failure.retryAfter) } : undefined)
      }
      return null
    }

    function fieldsOf(url: URL, fallback: string) {
      const fields = url.searchParams.get("fields")
      return parseFields(fields && fields.trim() ? fields : fallback)
    }

    const pageSizeOf = (url: URL) => {
      const asked = Number(url.searchParams.get("pageSize") ?? "100")
      return Math.max(1, Math.min(Number.isFinite(asked) ? asked : 100, 1000, maxPageSize))
    }
    const encodeOffset = (n: number) => Buffer.from(`offset:${n}`).toString("base64url")
    const decodeOffset = (token: string | null) => {
      if (!token) return 0
      const match = /^offset:(\d+)$/.exec(Buffer.from(token, "base64url").toString("utf8"))
      if (!match) throw new FakeQueryError("Invalid pageToken")
      return Number(match[1])
    }

    return [
      {
        method: "POST",
        path: "/token",
        async handle(request) {
          const form = new URLSearchParams(await request.text())
          const invalid = (description: string) => Response.json({ error: "invalid_grant", error_description: description }, { status: 400 })
          if (form.get("grant_type") !== JWT_BEARER_GRANT) return Response.json({ error: "unsupported_grant_type", error_description: "Invalid grant_type" }, { status: 400 })
          const jwt = decodeJwt(form.get("assertion") ?? "")
          if (!jwt || jwt.header.alg !== "RS256") return invalid("Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.")
          const { iss, scope, aud, iat, exp } = jwt.claims
          const now = Math.floor(Date.now() / 1000)
          if (iss !== DRIVE_FAKE_SA_EMAIL) return invalid("Invalid JWT Signature.")
          if (aud !== GOOGLE_TOKEN_AUDIENCE) return invalid("Invalid JWT: aud must be the token endpoint.")
          if (typeof scope !== "string" || !scope.split(" ").includes(DRIVE_SCOPE)) return Response.json({ error: "invalid_scope", error_description: "Invalid OAuth scope or ID token audience provided." }, { status: 400 })
          if (typeof iat !== "number" || typeof exp !== "number" || exp - iat > TOKEN_LIFETIME_S || exp <= now || iat > now + 300) {
            return invalid("Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.")
          }
          if (publicKey && !verify("RSA-SHA256", Buffer.from(jwt.signed), createPublicKey(publicKey), jwt.signature)) return invalid("Invalid JWT Signature.")
          const accessToken = `ya29.fixture-${nextToken++}`
          tokens.add(accessToken)
          return Response.json({ access_token: accessToken, expires_in: TOKEN_LIFETIME_S, token_type: "Bearer" })
        },
      },
      {
        method: "GET",
        path: "/drive/v3/files",
        async handle(request) {
          const blocked = gate(request)
          if (blocked) return blocked
          const url = new URL(request.url)
          try {
            const query = url.searchParams.get("q")
            const predicate = query ? parseDriveQuery(query) : null
            if (predicate?.fullText && url.searchParams.get("orderBy")) {
              return driveError(400, "badRequest", "Sorting is not supported for queries with fullText terms. Results are always in descending relevance order.")
            }
            const matches = [...items.values()].filter(
              (item) =>
                visible(item) &&
                (!predicate || predicate({ id: item.id, name: item.name, mimeType: item.mimeType, parents: item.parent ? [item.parent] : [], trashed: item.trashed ?? false, modifiedTime: item.modifiedTime, text: item.text ?? "" })),
            )
            const offset = decodeOffset(url.searchParams.get("pageToken"))
            const size = pageSizeOf(url)
            const page = matches.slice(offset, offset + size)
            const body = {
              kind: "drive#fileList",
              incompleteSearch: false,
              ...(offset + size < matches.length ? { nextPageToken: encodeOffset(offset + size) } : {}),
              files: await Promise.all(page.map(resource)),
            }
            return Response.json(project(body, fieldsOf(url, "kind,incompleteSearch,nextPageToken,files(kind,id,name,mimeType)")))
          } catch (error) {
            if (error instanceof FakeQueryError) return driveError(400, "badRequest", `Invalid Value: ${error.message}`)
            throw error
          }
        },
      },
      {
        method: "GET",
        path: "/drive/v3/files/:id",
        async handle(request, { params }) {
          const blocked = gate(request)
          if (blocked) return blocked
          const url = new URL(request.url)
          const item = items.get(params.id)
          if (!item || !visible(item)) return notFound(params.id)
          if (url.searchParams.get("alt") !== "media") {
            try {
              return Response.json(project(await resource(item), fieldsOf(url, "kind,id,name,mimeType")))
            } catch (error) {
              if (error instanceof FakeQueryError) return driveError(400, "badRequest", `Invalid field selection: ${error.message}`)
              throw error
            }
          }
          if (item.mimeType.startsWith(WORKSPACE)) return driveError(403, "fileNotDownloadable", "Only files with binary content can be downloaded. Use Export with Docs Editors files.")
          if (item.canDownload === false) return driveError(403, "cannotDownloadFile", "The user does not have sufficient permissions for this file.")
          const bytes = (await bytesOf(item)) ?? new Uint8Array()
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "")
          if (range) {
            const start = Number(range[1])
            const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1)
            return new Response(Buffer.from(bytes.subarray(start, end + 1)), { status: 206, headers: { "content-type": item.mimeType, "content-range": `bytes ${start}-${end}/${bytes.length}` } })
          }
          return new Response(Buffer.from(bytes), { headers: { "content-type": item.mimeType, "content-length": String(bytes.length) } })
        },
      },
      {
        method: "GET",
        path: "/drive/v3/files/:id/export",
        async handle(request, { params }) {
          const blocked = gate(request)
          if (blocked) return blocked
          const item = items.get(params.id)
          if (!item || !visible(item)) return notFound(params.id)
          const mimeType = new URL(request.url).searchParams.get("mimeType")
          if (!mimeType) return driveError(400, "required", "Required parameter: mimeType")
          if (!item.mimeType.startsWith(WORKSPACE) || !EXPORTS[item.mimeType]) return driveError(403, "fileNotExportable", "Export only supports Docs Editors files.")
          if (!EXPORTS[item.mimeType].includes(mimeType)) return driveError(400, "badRequest", "The requested conversion is not supported.")
          if (item.oversizeExport) return driveError(403, "exportSizeLimitExceeded", "This file is too large to be exported.")
          if (item.canDownload === false) return driveError(403, "cannotExportFile", "The user does not have sufficient permissions for this file.")
          const text = item.exports?.[mimeType] ?? ""
          return new Response(Buffer.from(strToU8(text)), { headers: { "content-type": `${mimeType}; charset=utf-8` } })
        },
      },
      {
        method: "GET",
        path: "/drive/v3/changes/startPageToken",
        handle(request) {
          return gate(request) ?? Response.json({ kind: "drive#startPageToken", startPageToken: String(log.length + 1) })
        },
      },
      {
        method: "GET",
        path: "/drive/v3/changes",
        async handle(request) {
          const blocked = gate(request)
          if (blocked) return blocked
          const url = new URL(request.url)
          const token = url.searchParams.get("pageToken")
          if (!token) return driveError(400, "required", "Required parameter: pageToken")
          const start = Number(token) - 1
          if (!Number.isInteger(start) || start < 0 || start > log.length) return driveError(400, "invalid", "Invalid Value")
          const size = pageSizeOf(url)
          const entries = log.slice(start, start + size)
          const changes = await Promise.all(
            entries.map(async ({ fileId, time }) => {
              const item = items.get(fileId)
              return item && visible(item) ? { kind: "drive#change", changeType: "file", fileId, removed: false, time, file: await resource(item) } : { kind: "drive#change", changeType: "file", fileId, removed: true, time }
            }),
          )
          const more = start + size < log.length
          const body = { kind: "drive#changeList", ...(more ? { nextPageToken: String(start + size + 1) } : { newStartPageToken: String(log.length + 1) }), changes }
          try {
            return Response.json(project(body, fieldsOf(url, "kind,nextPageToken,newStartPageToken,changes(kind,changeType,time,removed,fileId,file(kind,id,name,mimeType))")))
          } catch (error) {
            if (error instanceof FakeQueryError) return driveError(400, "badRequest", `Invalid field selection: ${error.message}`)
            throw error
          }
        },
      },
      {
        // Test hook: change the folder the way an officer would, adding entries to the changes feed
        method: "POST",
        path: "/_fake/mutate",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as Record<string, string | undefined>
          const item = body.id ? items.get(body.id) : undefined
          if (!item && body.op !== "add" && body.op !== "unshare-root" && body.op !== "share-root") return Response.json({ fake: true, error: `No fake file ${body.id}` }, { status: 404 })
          const need = () => item!
          switch (body.op) {
            case "rename": {
              const target = need()
              target.name = body.name ?? target.name
              bump(target)
              record(target)
              break
            }
            case "edit": {
              const target = need()
              const text = body.text ?? ""
              if (target.exports) target.exports = Object.fromEntries(Object.keys(target.exports).map((type) => [type, text]))
              else target.bytes = async () => strToU8(text)
              bytesCache.delete(target.id)
              target.text = text
              bump(target)
              record(target)
              break
            }
            case "move": {
              const target = need()
              target.parent = body.parent ?? null
              bump(target)
              record(target, ...descendants(target.id))
              break
            }
            case "trash":
            case "untrash": {
              const target = need()
              for (const one of [target, ...descendants(target.id)]) {
                one.trashed = body.op === "trash"
                bump(one)
              }
              record(target, ...descendants(target.id))
              break
            }
            case "delete": {
              const target = need()
              const gone = [target, ...descendants(target.id)]
              for (const one of gone) items.delete(one.id)
              record(...gone.map((one) => one.id))
              break
            }
            case "add": {
              if (!body.id || items.has(body.id)) return Response.json({ fake: true, error: "add needs a new id" }, { status: 400 })
              const mimeType = body.mimeType ?? DOC
              const text = body.text ?? ""
              const added: FakeDriveItem = {
                id: body.id,
                name: body.name ?? "Untitled",
                mimeType,
                parent: body.parent ?? DRIVE_FAKE_ROOT_ID,
                version: 1,
                modifiedTime: new Date().toISOString(),
                text,
                ...(mimeType === DOC
                  ? { exports: { "text/markdown": text, "text/plain": text } }
                  : mimeType === FOLDER
                    ? {}
                    : mimeType === PPTX
                      ? { bytes: async () => fakePptx([{ lines: text.split("\n") }]) }
                      : { bytes: async () => strToU8(text) }),
              }
              items.set(added.id, added)
              record(added)
              break
            }
            case "unshare-root":
            case "share-root": {
              const root = items.get(DRIVE_FAKE_ROOT_ID)!
              root.shared = body.op === "share-root"
              // quiet: the feed reports nothing (whether the real feed reports every file under an unshared folder isn't verified)
              if (!body.quiet) record(root, ...descendants(root.id))
              break
            }
            default:
              return Response.json({ fake: true, error: `Unknown op ${body.op}` }, { status: 400 })
          }
          return Response.json({ ok: true, changes: log.length })
        },
      },
      {
        // Test hook: the next `count` Drive API calls (to `path`, when given) answer with this error
        method: "POST",
        path: "/_fake/fail",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as { status?: number; reason?: string; count?: number; retryAfter?: number; path?: string }
          failures.push({ status: body.status ?? 503, reason: body.reason ?? "backendError", remaining: body.count ?? 1, retryAfter: body.retryAfter, path: body.path })
          return Response.json({ ok: true })
        },
      },
      {
        // Test hook: every token issued so far stops working (the client must sign in again)
        method: "POST",
        path: "/_fake/expire-tokens",
        handle() {
          tokens.clear()
          return Response.json({ ok: true })
        },
      },
      {
        // Test hook: { pem } turns on signature checks at /token; { maxPageSize } makes pages smaller
        method: "POST",
        path: "/_fake/config",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as { publicKey?: string; maxPageSize?: number }
          if (body.publicKey !== undefined) publicKey = body.publicKey || null
          if (body.maxPageSize !== undefined) maxPageSize = Math.max(1, body.maxPageSize)
          return Response.json({ ok: true })
        },
      },
    ]
  },
}

