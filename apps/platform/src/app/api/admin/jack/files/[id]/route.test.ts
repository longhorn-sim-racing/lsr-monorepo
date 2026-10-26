import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { memoryStore, type MemoryStore } from "@/server/jack/decks/memory-store"
import { setJackFileStore } from "@/server/jack/decks/storage"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const db = vi.hoisted(() => ({ jackFile: { findUnique: vi.fn() } }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/db", () => ({ prisma: db }))

import { GET } from "./route"

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
let store: MemoryStore

type Row = { status: string; filename: string; contentType: string; sizeBytes: number; storagePath: string; modelCopyPath: string | null; thumbPath: string | null }

const row = (fields: Partial<Row> = {}): Row => ({
  status: "READY",
  filename: "GM 2 \"sign-in\".csv",
  contentType: "text/csv",
  sizeBytes: 11,
  storagePath: `rooms/r/${ID}/GM-2-sign-in.csv`,
  modelCopyPath: null,
  thumbPath: null,
  ...fields,
})

const call = (query = "", id = ID) => GET(new NextRequest(`https://example.org/api/admin/jack/files/${id}${query}`), { params: Promise.resolve({ id }) })

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  store = memoryStore()
  setJackFileStore(store)
})

afterEach(() => setJackFileStore(null))

describe("GET /api/admin/jack/files/[id]", () => {
  it("is for officers only", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("NotAuthorized"))
    const res = await call()
    expect(res.status).toBe(403)
    expect(db.jackFile.findUnique).not.toHaveBeenCalled()
  })

  it("serves a document as a locked-down download: nosniff, sandboxed, never cached", async () => {
    db.jackFile.findUnique.mockResolvedValue(row())
    await store.put(row().storagePath, Buffer.from("name,email\n"), "text/csv")
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("content-security-policy")).toBe("sandbox")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("content-type")).toBe("text/csv")
    // The quotes in the name can't break out of the header
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="GM 2 _sign-in_.csv"; filename*=UTF-8''GM%202%20%22sign-in%22.csv`)
    expect(await res.text()).toBe("name,email\n")
  })

  it("shows raster images inline, and caches thumbnails for good", async () => {
    const photo = row({ filename: "car.png", contentType: "image/png", storagePath: "rooms/r/x/car.png", thumbPath: "rooms/r/x/derived/thumb.jpg" })
    db.jackFile.findUnique.mockResolvedValue(photo)
    await store.put(photo.storagePath, Buffer.from("png"), "image/png")
    await store.put(photo.thumbPath!, Buffer.from("thumb"), "image/jpeg")
    const original = await call()
    expect(original.headers.get("content-disposition")).toMatch(/^inline;/)
    expect(original.headers.get("cache-control")).toBe("private, no-store")
    const thumb = await call("?variant=thumb")
    expect(thumb.headers.get("content-type")).toBe("image/jpeg")
    expect(thumb.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
    expect(thumb.headers.get("content-security-policy")).toBe("sandbox")
    expect(await thumb.text()).toBe("thumb")
  })

  it("redirects a file over 4 MB to a short signed link that downloads it", async () => {
    db.jackFile.findUnique.mockResolvedValue(row({ sizeBytes: 9_000_000 }))
    const res = await call()
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`https://storage.test/signed/${row().storagePath}?ttl=60000&download=${encodeURIComponent('GM 2 "sign-in".csv')}`)
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  it("only serves READY files, by a real id, and only the variants a file has", async () => {
    db.jackFile.findUnique.mockResolvedValue(row({ status: "UPLOADING" }))
    expect((await call()).status).toBe(404)
    db.jackFile.findUnique.mockResolvedValue(row())
    expect((await call("?variant=model")).status).toBe(404)
    expect((await call("?variant=../../secret")).status).toBe(400)
    expect((await call("", "../../etc/passwd")).status).toBe(400)
    db.jackFile.findUnique.mockResolvedValue(null)
    expect((await call()).status).toBe(404)
  })

  it("answers 404 when the bytes are missing from the store", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    db.jackFile.findUnique.mockResolvedValue(row())
    expect((await call()).status).toBe(404)
  })
})
