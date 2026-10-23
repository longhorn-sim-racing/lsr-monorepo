import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Where Jack's files are kept: deck renders, exports and screenshots (#177), and the files officers
 * attach in rooms (#188, design §2.1). Nothing in it is public: officers get files through the admin
 * routes, which check the role first, and a file too big for a function response goes out as a
 * short-lived signed link.
 *
 * - Supabase: Supabase Storage, the private bucket `jack`, with the service-role key (server only).
 *   The default when SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL are set. It has no cap on
 *   operations (Vercel Blob on Hobby allows 2,000 writes a month) and takes signed uploads straight
 *   from the browser. `scripts/jack-storage-setup.ts` creates the bucket.
 * - Blob: a private Vercel Blob store (BLOB_STORE_ID with Vercel's OIDC token, or BLOB_READ_WRITE_TOKEN),
 *   kept for a later move to Pro. No signed uploads, so room files need Supabase.
 * - Files: `.jack-renders/` under the app (gitignored), when not on Vercel and nothing else is set.
 * - None: on Vercel with no store. Nothing is cached, so every image is rendered again when asked
 *   for; slower, but it works until a store is connected.
 *
 * JACK_FILE_STORE=supabase|blob|files picks one; a choice that isn't configured falls back to the default.
 */

export type JackFileStoreKind = "supabase" | "blob" | "files" | "none"

export type StoredFileInfo = { size: number; contentType: string | null }
export type StoredFileItem = { pathname: string; size: number }

export type JackFileStore = {
  kind: JackFileStoreKind
  get(pathname: string): Promise<Buffer | null>
  put(pathname: string, body: Buffer, contentType: string): Promise<void>
  /** Size and type, or null when it isn't there */
  head(pathname: string): Promise<StoredFileInfo | null>
  /** Deletes what's there; missing paths are fine */
  delete(pathnames: string[]): Promise<void>
  /** Files whose path starts with `prefix`, a page at a time (`cursor` from the last page, null at the end) */
  list(prefix: string, options?: { cursor?: string; limit?: number }): Promise<{ items: StoredFileItem[]; cursor: string | null }>
  /** A link that works without signing in, for a few minutes. `download` names the file and makes it download. Null when the store can't make one */
  signedUrl(pathname: string, ttlMs: number, options?: { download?: string }): Promise<string | null>
  /**
   * A URL the browser can upload exactly this path to, once, without the service key (Supabase's
   * createSignedUploadUrl). Only Supabase has it
   */
  signedUploadUrl?(pathname: string): Promise<{ url: string; token: string }>
}

/** The Supabase Storage bucket */
export const JACK_BUCKET = "jack"

let cached: JackFileStore | null = null

export function jackFileStore(): JackFileStore {
  if (!cached) cached = createStore(process.env)
  return cached
}

/** For tests */
export function setJackFileStore(store: JackFileStore | null) {
  cached = store
}

type StoreEnv = Readonly<Record<string, string | undefined>>

/** Which store the environment picks (see the top of this file). Pure, for tests */
export function storeKindFor(env: StoreEnv): JackFileStoreKind {
  const supabase = Boolean(env.SUPABASE_SERVICE_ROLE_KEY?.trim() && env.NEXT_PUBLIC_SUPABASE_URL?.trim())
  const blob = Boolean(env.BLOB_READ_WRITE_TOKEN?.trim() || env.BLOB_STORE_ID?.trim())
  const choice = env.JACK_FILE_STORE?.trim().toLowerCase()
  if (choice === "supabase" && supabase) return "supabase"
  if (choice === "blob" && blob) return "blob"
  if (choice === "files") return "files"
  if (supabase) return "supabase"
  if (blob) return "blob"
  return env.VERCEL ? "none" : "files"
}

function createStore(env: StoreEnv): JackFileStore {
  const kind = storeKindFor(env)
  const choice = env.JACK_FILE_STORE?.trim().toLowerCase()
  if (choice && choice !== kind) console.warn(`[jack] JACK_FILE_STORE=${choice} isn't usable here (not configured, or not a store); using ${kind}.`)
  if (kind === "supabase") return supabaseStore({ url: env.NEXT_PUBLIC_SUPABASE_URL!.trim(), serviceKey: env.SUPABASE_SERVICE_ROLE_KEY!.trim() })
  if (kind === "blob") return blobStore()
  if (kind === "files") return fileStore(path.join(process.cwd(), ".jack-renders"))
  console.warn("[jack] No file store is connected, so deck renders aren't cached and room files can't be uploaded. Set SUPABASE_SERVICE_ROLE_KEY (see docs/jack-2/tracks/files.md).")
  return noStore()
}

/** Supabase answers a missing object with a 400 whose body says 404, or (downloads) a bare 400/404 response */
async function isNotFound(error: unknown): Promise<boolean> {
  const e = error as { status?: number; statusCode?: string; message?: string; originalError?: unknown }
  if (e.status === 404 || e.statusCode === "404" || /not.?found/i.test(e.message ?? "")) return true
  const response = e.originalError
  if (response instanceof Response) {
    if (response.status === 404) return true
    const body = (await response.clone().json().catch(() => null)) as { statusCode?: string; error?: string } | null
    return body?.statusCode === "404" || body?.error === "not_found"
  }
  return false
}

function storageError(what: string, error: unknown): Error {
  const e = error as { message?: string; statusCode?: string; status?: number }
  const detail = e.message && e.message !== "{}" ? e.message : `status ${e.statusCode ?? e.status ?? "unknown"}`
  return new Error(`Supabase Storage couldn't ${what}: ${detail}`)
}

/** Supabase's remove() takes at most 1,000 paths a call */
const REMOVE_BATCH = 1_000

export function supabaseStore({ url, serviceKey, bucket = JACK_BUCKET, fetch }: { url: string; serviceKey: string; bucket?: string; fetch?: typeof globalThis.fetch }): JackFileStore {
  let client: Promise<SupabaseClient> | null = null
  const files = async () => {
    client ??= import("@supabase/supabase-js").then(({ createClient }) =>
      createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        ...(fetch ? { global: { fetch } } : {}),
      }),
    )
    return (await client).storage.from(bucket)
  }
  return {
    kind: "supabase",
    async get(pathname) {
      const { data, error } = await (await files()).download(pathname)
      if (error) {
        if (await isNotFound(error)) return null
        throw storageError(`read ${pathname}`, error)
      }
      return Buffer.from(await data.arrayBuffer())
    },
    async put(pathname, body, contentType) {
      const { error } = await (await files()).upload(pathname, body, { contentType, upsert: true })
      if (error) throw storageError(`save ${pathname}`, error)
    },
    async head(pathname) {
      const { data, error } = await (await files()).info(pathname)
      if (error) {
        if (await isNotFound(error)) return null
        throw storageError(`look up ${pathname}`, error)
      }
      const info = data as { size?: number | null; contentType?: string | null; metadata?: { size?: number; mimetype?: string } | null }
      return { size: Number(info.size ?? info.metadata?.size ?? 0), contentType: info.contentType ?? info.metadata?.mimetype ?? null }
    },
    async delete(pathnames) {
      const bucketFiles = await files()
      for (let i = 0; i < pathnames.length; i += REMOVE_BATCH) {
        const { error } = await bucketFiles.remove(pathnames.slice(i, i + REMOVE_BATCH))
        if (error) throw storageError("delete files", error)
      }
    },
    async list(prefix, { cursor, limit = 1_000 } = {}) {
      const { data, error } = await (await files()).listV2({ prefix, cursor, limit, with_delimiter: false })
      if (error) throw storageError(`list ${prefix}`, error)
      const items = data.objects.map((object) => {
        const named = object as { key?: string; name: string; metadata?: { size?: number } | null }
        return { pathname: named.key ?? named.name, size: Number(named.metadata?.size ?? 0) }
      })
      return { items, cursor: data.hasNext ? (data.nextCursor ?? null) : null }
    },
    async signedUrl(pathname, ttlMs, options = {}) {
      const seconds = Math.max(1, Math.round(ttlMs / 1000))
      const { data, error } = await (await files()).createSignedUrl(pathname, seconds, options.download ? { download: options.download } : undefined)
      if (error) throw storageError(`sign a link to ${pathname}`, error)
      return data.signedUrl
    },
    async signedUploadUrl(pathname) {
      // upsert stays off: the link can create this one path, never overwrite it
      const { data, error } = await (await files()).createSignedUploadUrl(pathname)
      if (error) throw storageError(`sign an upload to ${pathname}`, error)
      return { url: data.signedUrl, token: data.token }
    },
  }
}

function blobStore(): JackFileStore {
  const sdk = () => import("@vercel/blob")
  return {
    kind: "blob",
    async get(pathname) {
      const { get } = await sdk()
      const found = await get(pathname, { access: "private" })
      if (!found || found.statusCode !== 200 || !found.stream) return null
      return Buffer.from(await new Response(found.stream).arrayBuffer())
    },
    async put(pathname, body, contentType) {
      const { put } = await sdk()
      await put(pathname, body, { access: "private", contentType, addRandomSuffix: false, allowOverwrite: true })
    },
    async head(pathname) {
      const { head, BlobNotFoundError } = await sdk()
      try {
        const found = await head(pathname)
        return { size: found.size, contentType: found.contentType ?? null }
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null
        throw error
      }
    },
    async delete(pathnames) {
      if (!pathnames.length) return
      const { del } = await sdk()
      await del(pathnames)
    },
    async list(prefix, { cursor, limit = 1_000 } = {}) {
      const { list } = await sdk()
      const page = await list({ prefix, cursor, limit })
      return { items: page.blobs.map((blob) => ({ pathname: blob.pathname, size: blob.size })), cursor: page.hasMore ? (page.cursor ?? null) : null }
    },
    async signedUrl(pathname, ttlMs) {
      const { issueSignedToken, presignUrl } = await sdk()
      const validUntil = Date.now() + ttlMs
      const token = await issueSignedToken({ pathname, operations: ["get"], validUntil })
      const { presignedUrl } = await presignUrl(token, { operation: "get", pathname, access: "private", validUntil })
      return presignedUrl
    },
  }
}

export function fileStore(root: string): JackFileStore {
  const base = path.resolve(root)
  const resolve = (pathname: string) => {
    const full = path.resolve(base, pathname)
    if (!full.startsWith(base + path.sep)) throw new Error(`Bad store path: ${pathname}`)
    return full
  }
  return {
    kind: "files",
    async get(pathname) {
      try {
        return await readFile(resolve(pathname))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
    },
    async put(pathname, body) {
      const full = resolve(pathname)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, body)
    },
    async head(pathname) {
      try {
        const info = await stat(resolve(pathname))
        return info.isFile() ? { size: info.size, contentType: null } : null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
    },
    async delete(pathnames) {
      await Promise.all(pathnames.map((pathname) => rm(resolve(pathname), { force: true })))
    },
    async list(prefix, { cursor, limit = 1_000 } = {}) {
      const all = (await walk(base)).map((full) => path.relative(base, full).split(path.sep).join("/")).filter((name) => name.startsWith(prefix)).sort()
      const start = cursor ? all.findIndex((name) => name > cursor) : 0
      const page = start < 0 ? [] : all.slice(start, start + limit)
      const items = await Promise.all(page.map(async (name) => ({ pathname: name, size: (await stat(resolve(name))).size })))
      return { items, cursor: start >= 0 && start + limit < all.length ? page[page.length - 1] : null }
    },
    async signedUrl() {
      return null
    },
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : Promise.resolve([path.join(dir, entry.name)]))))
  return nested.flat()
}

function noStore(): JackFileStore {
  return {
    kind: "none",
    async get() {
      return null
    },
    async put() {},
    async head() {
      return null
    },
    async delete() {},
    async list() {
      return { items: [], cursor: null }
    },
    async signedUrl() {
      return null
    },
  }
}
