import type { JackFileStore, JackFileStoreKind } from "./storage"

/**
 * An in-memory JackFileStore for tests: what was put, with its type, readable back. Pretends to be
 * Supabase by default (signed links and signed uploads included) so the room-file code takes its
 * production path.
 */
export type MemoryStore = JackFileStore & { files: Map<string, { body: Buffer; contentType: string }>; signedUploads: string[] }

export function memoryStore(kind: JackFileStoreKind = "supabase"): MemoryStore {
  const files = new Map<string, { body: Buffer; contentType: string }>()
  const signedUploads: string[] = []
  return {
    kind,
    files,
    signedUploads,
    async get(pathname) {
      return files.get(pathname)?.body ?? null
    },
    async put(pathname, body, contentType) {
      files.set(pathname, { body, contentType })
    },
    async head(pathname) {
      const file = files.get(pathname)
      return file ? { size: file.body.length, contentType: file.contentType } : null
    },
    async delete(pathnames) {
      for (const pathname of pathnames) files.delete(pathname)
    },
    async list(prefix, { cursor, limit = 1_000 } = {}) {
      const names = [...files.keys()].filter((name) => name.startsWith(prefix) && (!cursor || name > cursor)).sort()
      const page = names.slice(0, limit)
      return { items: page.map((pathname) => ({ pathname, size: files.get(pathname)!.body.length })), cursor: names.length > limit ? page[page.length - 1] : null }
    },
    async signedUrl(pathname, ttlMs, options = {}) {
      return `https://storage.test/signed/${pathname}?ttl=${ttlMs}${options.download ? `&download=${encodeURIComponent(options.download)}` : ""}`
    },
    ...(kind === "supabase"
      ? {
          async signedUploadUrl(pathname: string) {
            signedUploads.push(pathname)
            return { url: `https://storage.test/upload/sign/jack/${pathname}?token=t`, token: "t" }
          },
        }
      : {}),
  }
}
