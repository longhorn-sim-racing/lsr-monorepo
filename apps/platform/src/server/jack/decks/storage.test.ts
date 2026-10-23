import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fileStore, storeKindFor, supabaseStore } from "./storage"

describe("storeKindFor: which store the environment picks", () => {
  const supabase = { SUPABASE_SERVICE_ROLE_KEY: "service-key", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }
  const blob = { BLOB_STORE_ID: "store_1" }

  it("defaults to Supabase when its key and URL are set, then Blob, then a local folder, then nothing on Vercel", () => {
    expect(storeKindFor({ ...supabase, ...blob })).toBe("supabase")
    expect(storeKindFor(blob)).toBe("blob")
    expect(storeKindFor({ BLOB_READ_WRITE_TOKEN: "rw" })).toBe("blob")
    expect(storeKindFor({})).toBe("files")
    expect(storeKindFor({ VERCEL: "1" })).toBe("none")
    expect(storeKindFor({ SUPABASE_SERVICE_ROLE_KEY: "service-key" })).toBe("files")
  })

  it("takes JACK_FILE_STORE when that store is configured, and falls back when it isn't", () => {
    expect(storeKindFor({ ...supabase, ...blob, JACK_FILE_STORE: "blob" })).toBe("blob")
    expect(storeKindFor({ ...supabase, JACK_FILE_STORE: "files" })).toBe("files")
    expect(storeKindFor({ ...blob, JACK_FILE_STORE: "Supabase" })).toBe("blob")
    expect(storeKindFor({ ...supabase, JACK_FILE_STORE: "s3" })).toBe("supabase")
  })
})

/**
 * Supabase Storage's REST API as @supabase/storage-js 2.98 calls it, with its error shapes (a missing
 * object is a 400 whose body says statusCode "404"), so the store runs the real SDK code
 */
function fakeStorage() {
  const objects = new Map<string, { body: Buffer; contentType: string }>()
  const calls: { method: string; path: string; headers: Headers; body?: unknown }[] = []
  const notFound = () => Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 })
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = (init.method ?? "GET").toUpperCase()
    const route = decodeURIComponent(url.pathname.replace(/^\/storage\/v1/, ""))
    const headers = new Headers(init.headers)
    const json = typeof init.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ method, path: route, headers, body: json })
    if (headers.get("authorization") !== "Bearer service-key") return Response.json({ statusCode: "403", error: "Unauthorized", message: "invalid key" }, { status: 400 })
    let match: RegExpExecArray | null
    if ((match = /^\/object\/info\/jack\/(.+)$/.exec(route)) && method === "GET") {
      const object = objects.get(match[1])
      return object ? Response.json({ name: match[1], size: object.body.length, content_type: object.contentType, metadata: {} }) : notFound()
    }
    if ((match = /^\/object\/list-v2\/jack$/.exec(route))) {
      const names = [...objects.keys()].filter((name) => name.startsWith(json.prefix ?? "") && (!json.cursor || name > json.cursor)).sort()
      const page = names.slice(0, json.limit)
      return Response.json({ hasNext: names.length > json.limit, nextCursor: names.length > json.limit ? page.at(-1) : undefined, folders: [], objects: page.map((name) => ({ id: name, name, metadata: { size: objects.get(name)!.body.length } })) })
    }
    if ((match = /^\/object\/upload\/sign\/jack\/(.+)$/.exec(route)) && method === "POST") return Response.json({ url: `/object/upload/sign/jack/${match[1]}?token=upload-token` })
    if ((match = /^\/object\/sign\/jack\/(.+)$/.exec(route))) return objects.has(match[1]) ? Response.json({ signedURL: `/object/sign/jack/${match[1]}?token=read-token` }) : notFound()
    if (route === "/object/jack" && method === "DELETE") {
      for (const prefix of json.prefixes) objects.delete(prefix)
      return Response.json([])
    }
    if ((match = /^\/object\/jack\/(.+)$/.exec(route))) {
      if (method === "GET") {
        const object = objects.get(match[1])
        return object ? new Response(new Uint8Array(object.body)) : notFound()
      }
      if (method === "POST" || method === "PUT") {
        if (match[1].startsWith("broken/")) return Response.json({ statusCode: "500", error: "DatabaseError", message: "database error, code: 42P10" }, { status: 500 })
        objects.set(match[1], { body: Buffer.from(init.body as Uint8Array), contentType: headers.get("content-type") ?? "" })
        return Response.json({ Key: `jack/${match[1]}`, Id: "1" })
      }
    }
    return new Response("no route", { status: 404 })
  }) as typeof globalThis.fetch
  return { objects, calls, fetch }
}

describe("supabaseStore", () => {
  let fake: ReturnType<typeof fakeStorage>
  let store: ReturnType<typeof supabaseStore>
  beforeEach(() => {
    fake = fakeStorage()
    store = supabaseStore({ url: "http://supabase.test", serviceKey: "service-key", fetch: fake.fetch })
  })

  it("puts (overwriting), gets back, and says null for a missing file", async () => {
    await store.put("jack/renders/k/full.png", Buffer.from("png"), "image/png")
    expect(fake.calls[0].headers.get("x-upsert")).toBe("true")
    expect(fake.objects.get("jack/renders/k/full.png")?.contentType).toBe("image/png")
    expect((await store.get("jack/renders/k/full.png"))?.toString()).toBe("png")
    expect(await store.get("jack/renders/missing.png")).toBeNull()
  })

  it("heads a file with its size and type, or null", async () => {
    await store.put("rooms/r/f/a.csv", Buffer.from("a,b\n"), "text/csv")
    expect(await store.head("rooms/r/f/a.csv")).toEqual({ size: 4, contentType: "text/csv" })
    expect(await store.head("rooms/r/f/nope.csv")).toBeNull()
  })

  it("deletes in batches of 1,000 paths", async () => {
    await store.put("a", Buffer.from("1"), "text/plain")
    await store.delete(["a", ...Array.from({ length: 1_500 }, (_, i) => `missing-${i}`)])
    expect(fake.calls.filter((c) => c.method === "DELETE").map((c) => (c.body as { prefixes: string[] }).prefixes.length)).toEqual([1_000, 501])
    expect(fake.objects.has("a")).toBe(false)
  })

  it("lists by prefix, a page at a time", async () => {
    for (const name of ["jack/assets/a.png", "jack/assets/b.png", "jack/assets/c.png", "rooms/x"]) await store.put(name, Buffer.from(name), "image/png")
    const first = await store.list("jack/assets/", { limit: 2 })
    expect(first.items.map((i) => i.pathname)).toEqual(["jack/assets/a.png", "jack/assets/b.png"])
    expect(first.items[0].size).toBe("jack/assets/a.png".length)
    const rest = await store.list("jack/assets/", { limit: 2, cursor: first.cursor! })
    expect(rest).toEqual({ items: [{ pathname: "jack/assets/c.png", size: 17 }], cursor: null })
  })

  it("signs a read link (optionally as a named download) and a one-path upload", async () => {
    await store.put("rooms/r/f/a.pdf", Buffer.from("%PDF"), "application/pdf")
    expect(await store.signedUrl("rooms/r/f/a.pdf", 60_000, { download: "Sponsor deck.pdf" })).toBe(
      "http://supabase.test/storage/v1/object/sign/jack/rooms/r/f/a.pdf?token=read-token&download=Sponsor%20deck.pdf"
    )
    expect(fake.calls.at(-1)?.body).toEqual({ expiresIn: 60 })
    const upload = await store.signedUploadUrl!("rooms/r/f2/photo.png")
    expect(upload).toEqual({ url: "http://supabase.test/storage/v1/object/upload/sign/jack/rooms/r/f2/photo.png?token=upload-token", token: "upload-token" })
    // upsert stays off: the link can't overwrite
    expect(fake.calls.at(-1)?.headers.get("x-upsert")).toBeNull()
  })

  it("throws a plain error for other failures, without the key", async () => {
    const error = await store.put("broken/x", Buffer.from("x"), "text/plain").catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Supabase Storage couldn't save broken/x: database error, code: 42P10")
    const wrongKey = supabaseStore({ url: "http://supabase.test", serviceKey: "wrong", fetch: fake.fetch })
    await expect(wrongKey.head("a")).rejects.toThrow("couldn't look up a: invalid key")
  })
})

describe("fileStore", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "jack-store-"))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("heads, lists, and deletes inside its folder", async () => {
    const store = fileStore(root)
    await store.put("rooms/r/f/a.txt", Buffer.from("hello"), "text/plain")
    await store.put("rooms/r/f/derived/thumb.jpg", Buffer.from("jpg"), "image/jpeg")
    await store.put("jack/renders/x.png", Buffer.from("png"), "image/png")
    expect(await store.head("rooms/r/f/a.txt")).toEqual({ size: 5, contentType: null })
    expect(await store.head("rooms/r/f/missing.txt")).toBeNull()
    expect((await store.list("rooms/")).items.map((i) => i.pathname)).toEqual(["rooms/r/f/a.txt", "rooms/r/f/derived/thumb.jpg"])
    const page = await store.list("", { limit: 2 })
    expect(page.items).toHaveLength(2)
    expect((await store.list("", { cursor: page.cursor! })).items).toHaveLength(1)
    await store.delete(["rooms/r/f/a.txt", "rooms/r/f/never-there.txt"])
    expect(await store.get("rooms/r/f/a.txt")).toBeNull()
    await expect(store.delete(["../outside.txt"])).rejects.toThrow("Bad store path")
  })
})
