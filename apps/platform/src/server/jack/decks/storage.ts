import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Where Jack's renders and exports are kept (#177): a private Vercel Blob store in production and on
 * previews, or a folder on disk in local development. Nothing in it is public: officers get files
 * through the admin routes, which check the role first, and a file too big for a function response
 * goes out as a short-lived signed link.
 *
 * - Blob: used when the project has a store connected (BLOB_STORE_ID with Vercel's OIDC token, or
 *   BLOB_READ_WRITE_TOKEN).
 * - Files: `.jack-renders/` under the app (gitignored), when not on Vercel and no store is set.
 * - None: on Vercel without a store. Nothing is cached, so every image is rendered again when asked
 *   for; slower, but it works until a store is connected.
 */

export type JackFileStore = {
  kind: "blob" | "files" | "none"
  get(pathname: string): Promise<Buffer | null>
  put(pathname: string, body: Buffer, contentType: string): Promise<void>
  /** A link that works without signing in, for a few minutes. Null when the store can't make one */
  signedUrl(pathname: string, ttlMs: number): Promise<string | null>
}

let cached: JackFileStore | null = null

export function jackFileStore(): JackFileStore {
  if (!cached) cached = createStore()
  return cached
}

/** For tests */
export function setJackFileStore(store: JackFileStore | null) {
  cached = store
}

function createStore(): JackFileStore {
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim() || process.env.BLOB_STORE_ID?.trim()) return blobStore()
  if (!process.env.VERCEL) return fileStore(path.join(process.cwd(), ".jack-renders"))
  console.warn("[jack] No Blob store is connected, so deck renders aren't cached. Connect a private Blob store to the project.")
  return noStore()
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
  const resolve = (pathname: string) => {
    const full = path.resolve(root, pathname)
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error(`Bad store path: ${pathname}`)
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
    async signedUrl() {
      return null
    },
  }
}

function noStore(): JackFileStore {
  return {
    kind: "none",
    async get() {
      return null
    },
    async put() {},
    async signedUrl() {
      return null
    },
  }
}
