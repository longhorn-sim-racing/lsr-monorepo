import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { memoryStore, type MemoryStore } from "@/server/jack/decks/memory-store"
import { createFakeFileDb } from "./test-db"

const db = vi.hoisted(() => ({ current: null as unknown }))
vi.mock("@/server/db", () => ({
  get prisma() {
    return db.current
  },
}))

import { docxFile, imageFile, pdfFile } from "./fixtures"
import { createUpload, MAX_PENDING_UPLOADS, registerFile, removeUpload, storeLocalUpload } from "./service"

const ROOM = "11111111-1111-4111-8111-111111111111"
const OFFICER = "officer-1"
let fake: ReturnType<typeof createFakeFileDb>
let store: MemoryStore

beforeEach(() => {
  fake = createFakeFileDb()
  db.current = fake
  fake.addRoom(ROOM)
  store = memoryStore()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(fake.now())
})

afterEach(() => {
  vi.useRealTimers()
})

const upload = (filename: string, size = 1_000, type = "") => createUpload(OFFICER, { roomId: ROOM, filename, size, type }, store)

/** Starts an upload, then puts these bytes where the signed URL points, as the browser would */
async function uploaded(filename: string, body: Buffer, type = "") {
  const ticket = await upload(filename, body.length, type)
  if (!ticket.ok) throw new Error(ticket.error)
  const row = fake.file(ticket.data.file.id)!
  await store.put(row.storagePath, body, ticket.data.contentType)
  return row
}

describe("createUpload", () => {
  it("saves an UPLOADING row and signs an upload for exactly rooms/<room>/<file>/<sanitized name>", async () => {
    const result = await upload("GM 2 sign-in (final).CSV", 2_048, "application/vnd.ms-excel")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = fake.file(result.data.file.id)!
    expect(row).toMatchObject({ status: "UPLOADING", roomId: ROOM, uploadedById: OFFICER, filename: "GM 2 sign-in (final).CSV", contentType: "text/csv", kind: "CSV", sizeBytes: 2_048 })
    expect(row.storagePath).toBe(`rooms/${ROOM}/${row.id}/GM-2-sign-in-final.csv`)
    expect(store.signedUploads).toEqual([row.storagePath])
    expect(result.data).toEqual({ file: { id: row.id, filename: "GM 2 sign-in (final).CSV", kind: "CSV", sizeBytes: 2_048 }, url: expect.stringContaining(row.storagePath), contentType: "text/csv" })
  })

  it("refuses what the rules refuse, saving nothing", async () => {
    expect(await upload("logo.svg")).toMatchObject({ ok: false, code: "bad_request", error: expect.stringContaining("SVG") })
    expect(await upload("big.pdf", 30_000_000)).toMatchObject({ ok: false, error: expect.stringContaining("limit is 25 MB") })
    expect(fake.state.files).toHaveLength(0)
  })

  it("refuses a room that's gone or archived", async () => {
    fake.addRoom("22222222-2222-4222-8222-222222222222", new Date())
    expect(await createUpload(OFFICER, { roomId: "22222222-2222-4222-8222-222222222222", filename: "a.txt", size: 5, type: "" }, store)).toMatchObject({ ok: false, code: "not_found" })
  })

  it("says uploads need Supabase when the store can't sign them (Blob, or none)", async () => {
    for (const kind of ["blob", "none"] as const) {
      const result = await createUpload(OFFICER, { roomId: ROOM, filename: "a.txt", size: 5, type: "" }, memoryStore(kind))
      expect(result).toMatchObject({ ok: false, code: "unavailable", error: expect.stringContaining("Supabase Storage") })
    }
  })

  it("points the local files store at the development upload route", async () => {
    const result = await createUpload(OFFICER, { roomId: ROOM, filename: "a.txt", size: 5, type: "" }, memoryStore("files"))
    expect(result.ok && result.data.url).toBe(`/api/admin/jack/files/${result.ok && result.data.file.id}/upload`)
  })

  it("caps how many unsent files an officer can have waiting in a room", async () => {
    for (let i = 0; i < MAX_PENDING_UPLOADS; i++) expect((await upload(`f${i}.txt`, 5)).ok).toBe(true)
    expect(await upload("one-more.txt", 5)).toMatchObject({ ok: false, error: expect.stringContaining("Send or remove some first") })
    // Another officer isn't held up
    expect((await createUpload("officer-2", { roomId: ROOM, filename: "x.txt", size: 5, type: "" }, store)).ok).toBe(true)
  })

  it("drops the row again when signing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    store.signedUploadUrl = async () => {
      throw new Error("Bucket not found")
    }
    expect(await upload("a.txt", 5)).toMatchObject({ ok: false, code: "unavailable" })
    expect(fake.state.files).toHaveLength(0)
  })
})

describe("registerFile", () => {
  it("checks a photo, strips its metadata into a model copy and thumbnail, and marks it READY", async () => {
    const photo = await imageFile("jpeg", { width: 2400, height: 1200 })
    const row = await uploaded("IMG_1234.JPG", photo, "image/jpeg")
    const result = await registerFile(row.id, OFFICER, store)
    expect(result).toEqual({
      ok: true,
      data: { id: row.id, filename: "IMG_1234.JPG", kind: "IMAGE", sizeBytes: photo.length, url: `/api/admin/jack/files/${row.id}`, thumbUrl: `/api/admin/jack/files/${row.id}?variant=thumb` },
    })
    const saved = fake.file(row.id)!
    expect(saved).toMatchObject({ status: "READY", width: 2400, height: 1200, textStatus: "none", error: null })
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(saved.modelCopyPath).toBe(`rooms/${ROOM}/${row.id}/derived/model.jpg`)
    const model = await sharp(store.files.get(saved.modelCopyPath!)!.body).metadata()
    expect(model).toMatchObject({ format: "jpeg", width: 2000, height: 1000 })
    expect(model.exif).toBeUndefined()
    expect(store.files.get(saved.thumbPath!)?.contentType).toBe("image/jpeg")
  })

  it("extracts text from documents and PDFs", async () => {
    const docx = await uploaded("minutes.docx", docxFile(["Decided: new sim rig"]))
    expect((await registerFile(docx.id, OFFICER, store)).ok).toBe(true)
    expect(fake.file(docx.id)).toMatchObject({ status: "READY", textStatus: "ok", text: expect.stringContaining("Decided: new sim rig") })

    const pdf = await uploaded("rules.pdf", await pdfFile(["Rule 1", "Rule 2"]))
    await registerFile(pdf.id, OFFICER, store)
    expect(fake.file(pdf.id)).toMatchObject({ status: "READY", pageCount: 2, textStatus: "ok" })
  })

  it("refuses bytes that aren't what the type says, deletes them and keeps the reason", async () => {
    const row = await uploaded("photo.png", Buffer.from("<html><script>alert(1)</script></html>"))
    const result = await registerFile(row.id, OFFICER, store)
    expect(result).toMatchObject({ ok: false, code: "bad_request", error: expect.stringContaining("doesn't look like a PNG") })
    expect(fake.file(row.id)).toMatchObject({ status: "FAILED", error: expect.stringContaining("PNG") })
    expect(store.files.has(row.storagePath)).toBe(false)
    // Asking again says the same, without checking again
    expect(await registerFile(row.id, OFFICER, store)).toMatchObject({ ok: false, error: expect.stringContaining("PNG") })
  })

  it("fails when nothing arrived, or a different size or type arrived", async () => {
    const missing = await upload("a.txt", 5)
    expect(missing.ok && (await registerFile(missing.data.file.id, OFFICER, store))).toMatchObject({ ok: false, error: expect.stringContaining("didn't arrive") })

    const short = await upload("b.txt", 50)
    if (!short.ok) throw new Error(short.error)
    await store.put(fake.file(short.data.file.id)!.storagePath, Buffer.from("tiny"), "text/plain")
    expect(await registerFile(short.data.file.id, OFFICER, store)).toMatchObject({ ok: false, error: expect.stringContaining("size") })

    const retyped = await upload("c.txt", 5)
    if (!retyped.ok) throw new Error(retyped.error)
    await store.put(fake.file(retyped.data.file.id)!.storagePath, Buffer.from("hello"), "text/html")
    expect(await registerFile(retyped.data.file.id, OFFICER, store)).toMatchObject({ ok: false, error: expect.stringContaining("type") })
  })

  it("keeps a good file whose text can't be read (READY, textStatus failed)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const row = await uploaded("scan.pdf", Buffer.from("%PDF-1.7\nnot really a pdf body"))
    expect((await registerFile(row.id, OFFICER, store)).ok).toBe(true)
    expect(fake.file(row.id)).toMatchObject({ status: "READY", textStatus: "failed", text: null })
  })

  it("is only for the officer who attached it, and returns a READY file as it is", async () => {
    const row = await uploaded("notes.txt", Buffer.from("hello"))
    expect(await registerFile(row.id, "officer-2", store)).toMatchObject({ ok: false, code: "forbidden" })
    expect((await registerFile(row.id, OFFICER, store)).ok).toBe(true)
    const again = await registerFile(row.id, OFFICER, store)
    expect(again).toMatchObject({ ok: true, data: { id: row.id } })
    expect(await registerFile("nope", OFFICER, store)).toMatchObject({ ok: false, code: "not_found" })
  })

  it("marks the file FAILED when the store breaks, with a plain message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const row = await uploaded("notes.txt", Buffer.from("hello"))
    store.get = async () => {
      throw new Error("Supabase Storage couldn't read: network down")
    }
    expect(await registerFile(row.id, OFFICER, store)).toMatchObject({ ok: false, code: "unavailable", error: expect.stringContaining("Attach it again") })
    expect(fake.file(row.id)?.status).toBe("FAILED")
  })
})

describe("removeUpload", () => {
  it("deletes an unsent file and its stored copies; only its uploader can, and never a posted one", async () => {
    const row = await uploaded("photo.png", await imageFile("png"))
    await registerFile(row.id, OFFICER, store)
    expect(store.files.size).toBe(3)
    expect(await removeUpload(row.id, "officer-2", store)).toMatchObject({ ok: false, code: "forbidden" })
    expect(await removeUpload(row.id, OFFICER, store)).toEqual({ ok: true, data: null })
    expect(fake.file(row.id)).toBeUndefined()
    expect(store.files.size).toBe(0)
    // Gone already is fine
    expect((await removeUpload(row.id, OFFICER, store)).ok).toBe(true)

    const posted = await uploaded("b.txt", Buffer.from("hello"))
    fake.file(posted.id)!.messageId = "msg-1"
    expect(await removeUpload(posted.id, OFFICER, store)).toMatchObject({ ok: false, error: expect.stringContaining("already posted") })
  })
})

describe("storeLocalUpload (development files store)", () => {
  it("takes the bytes once, for the uploader's own UPLOADING file", async () => {
    const files = memoryStore("files")
    const ticket = await createUpload(OFFICER, { roomId: ROOM, filename: "a.txt", size: 5, type: "" }, files)
    if (!ticket.ok) throw new Error(ticket.error)
    const id = ticket.data.file.id
    expect(await storeLocalUpload(id, "officer-2", Buffer.from("hello"), files)).toMatchObject({ ok: false, code: "forbidden" })
    expect(await storeLocalUpload(id, OFFICER, Buffer.from("hello"), files)).toEqual({ ok: true, data: null })
    expect(await storeLocalUpload(id, OFFICER, Buffer.from("again"), files)).toMatchObject({ ok: false, error: expect.stringContaining("already uploaded") })
    expect(await storeLocalUpload(id, OFFICER, Buffer.from("x"), store)).toMatchObject({ ok: false, code: "not_found" })
  })
})
