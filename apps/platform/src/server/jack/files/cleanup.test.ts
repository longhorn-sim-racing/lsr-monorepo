import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { memoryStore, type MemoryStore } from "@/server/jack/decks/memory-store"
import { derivedFilePath } from "./paths"
import { createFakeFileDb, matches, type FakeFile } from "./test-db"

const db = vi.hoisted(() => ({ current: null as unknown }))
vi.mock("@/server/db", () => ({
  get prisma() {
    return db.current
  },
}))

import { JOBS } from "@/server/scheduler/jobs/files"
import { cleanupRoomFiles, cleanupWhere, sweepOrphanFiles } from "./cleanup"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const ROOM = "11111111-1111-4111-8111-111111111111"
let fake: ReturnType<typeof createFakeFileDb>
let store: MemoryStore

beforeEach(() => {
  fake = createFakeFileDb()
  db.current = fake
  fake.addRoom()
  store = memoryStore()
})

/** A file created `age` ms before now, with its stored copies */
function file(id: string, age: number, fields: Partial<FakeFile> = {}) {
  const row = fake.addFile({ id, createdAt: new Date(fake.now().getTime() - age), storagePath: `rooms/r/${id}/a.png`, ...fields })
  for (const path of [row.storagePath, row.modelCopyPath, row.thumbPath]) if (path) void store.put(path, Buffer.from("x"), "image/png")
  return row
}

describe("which files the cleanup deletes", () => {
  it("takes uploads unfinished after 24 hours and unsent files after 7 days, never posted files or meeting transcripts", () => {
    const now = fake.now()
    const cases: [string, Parameters<typeof file>[2] & { age: number }, boolean][] = [
      ["uploading, 23 hours", { age: 23 * HOUR, status: "UPLOADING" }, false],
      ["uploading, 25 hours", { age: 25 * HOUR, status: "UPLOADING" }, true],
      ["ready and unsent, 6 days", { age: 6 * DAY, status: "READY" }, false],
      ["ready and unsent, 8 days", { age: 8 * DAY, status: "READY" }, true],
      ["failed and unsent, 8 days", { age: 8 * DAY, status: "FAILED" }, true],
      ["failed, 2 days", { age: 2 * DAY, status: "FAILED" }, false],
      ["posted, 90 days", { age: 90 * DAY, status: "READY", messageId: "msg-1" }, false],
      ["unsent but a meeting's transcript, 30 days", { age: 30 * DAY, status: "READY", meetingIds: ["meeting-1"] }, false],
    ]
    for (const [name, { age, ...fields }, due] of cases) {
      const row = file(name, age, fields)
      expect(matches(row, cleanupWhere(now)), name).toBe(due)
    }
  })
})

describe("cleanupRoomFiles", () => {
  it("deletes the due rows and every stored copy, leaving the rest alone", async () => {
    file("old-upload", 2 * DAY, { status: "UPLOADING" })
    file("old-photo", 10 * DAY, { status: "READY", modelCopyPath: "rooms/r/old-photo/derived/model.jpg", thumbPath: "rooms/r/old-photo/derived/thumb.jpg" })
    file("posted", 10 * DAY, { status: "READY", messageId: "msg-1" })
    file("fresh", HOUR, { status: "READY" })
    const result = await cleanupRoomFiles({ now: fake.now(), store })
    expect(result).toEqual({ deleted: 2, objects: 4, objectErrors: 0, more: false })
    expect(fake.state.files.map((f) => f.id).sort()).toEqual(["fresh", "posted"])
    expect([...store.files.keys()].sort()).toEqual(["rooms/r/fresh/a.png", "rooms/r/posted/a.png"])
  })

  it("keeps a file that was posted after it was picked, and its bytes", async () => {
    file("late", 10 * DAY, { status: "READY" })
    const findMany = fake.jackFile.findMany
    fake.jackFile.findMany = async (args) => {
      const rows = await findMany(args)
      fake.file("late")!.messageId = "msg-2" // posted in between
      return rows
    }
    expect(await cleanupRoomFiles({ now: fake.now(), store })).toMatchObject({ deleted: 0, objects: 0 })
    expect(store.files.has("rooms/r/late/a.png")).toBe(true)
  })

  it("works in batches and says when more are due", async () => {
    for (let i = 0; i < 5; i++) file(`old-${i}`, 10 * DAY, { status: "FAILED" })
    expect(await cleanupRoomFiles({ now: fake.now(), store, limit: 3 })).toMatchObject({ deleted: 3, more: true })
    expect(await cleanupRoomFiles({ now: fake.now(), store, limit: 3 })).toMatchObject({ deleted: 2, more: false })
  })

  it("stops when the run is aborted", async () => {
    file("a", 10 * DAY, { status: "FAILED" })
    const abort = new AbortController()
    abort.abort()
    expect(await cleanupRoomFiles({ now: fake.now(), store, signal: abort.signal })).toMatchObject({ deleted: 0, more: true })
  })

  it("deletes photo copies a registration stored but never recorded (it died before saving the row)", async () => {
    const id = "33333333-3333-4333-8333-333333333333"
    const row = file(id, 2 * DAY, { status: "UPLOADING", storagePath: `rooms/${ROOM}/${id}/IMG_1.jpg` })
    await store.put(derivedFilePath(row, "model"), Buffer.from("jpg"), "image/jpeg")
    await store.put(derivedFilePath(row, "thumb"), Buffer.from("jpg"), "image/jpeg")
    expect(await cleanupRoomFiles({ now: fake.now(), store })).toEqual({ deleted: 1, objects: 1, objectErrors: 0, more: false })
    expect([...store.files.keys()]).toEqual([])
  })

  it("counts stored copies it couldn't delete", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    file("a", 10 * DAY, { status: "FAILED" })
    store.delete = async () => {
      throw new Error("storage down")
    }
    expect(await cleanupRoomFiles({ now: fake.now(), store })).toEqual({ deleted: 1, objects: 0, objectErrors: 1, more: false })
  })
})

describe("sweepOrphanFiles", () => {
  const KEPT = "44444444-4444-4444-8444-444444444444"
  const GONE = "55555555-5555-4555-8555-555555555555"

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(fake.now().getTime() - 2 * DAY))
  })
  afterEach(() => vi.useRealTimers())

  it("deletes stored room files whose row is gone (a day old or more), never deck files or files with a row", async () => {
    file(KEPT, HOUR, { status: "READY", storagePath: `rooms/${ROOM}/${KEPT}/a.pdf` })
    await store.put(`rooms/${ROOM}/${GONE}/late-upload.pdf`, Buffer.from("%PDF"), "application/pdf")
    await store.put(`rooms/${ROOM}/${GONE}/derived/thumb.jpg`, Buffer.from("jpg"), "image/jpeg")
    await store.put("jack/assets/shot.png", Buffer.from("png"), "image/png")
    vi.setSystemTime(fake.now())
    const fresh = "66666666-6666-4666-8666-666666666666"
    await store.put(`rooms/${ROOM}/${fresh}/just-now.pdf`, Buffer.from("%PDF"), "application/pdf")

    expect(await sweepOrphanFiles({ now: fake.now(), store, pageSize: 2 })).toEqual({ deleted: 2, more: false })
    expect([...store.files.keys()].sort()).toEqual(["jack/assets/shot.png", `rooms/${ROOM}/${KEPT}/a.pdf`, `rooms/${ROOM}/${fresh}/just-now.pdf`])
  })

  it("stops when the run is aborted", async () => {
    await store.put(`rooms/${ROOM}/${GONE}/late-upload.pdf`, Buffer.from("%PDF"), "application/pdf")
    const abort = new AbortController()
    abort.abort()
    expect(await sweepOrphanFiles({ now: fake.now(), store, signal: abort.signal })).toEqual({ deleted: 0, more: true })
  })
})

describe("the files.cleanup job", () => {
  const job = JOBS.find((j) => j.kind === "files.cleanup")!
  const ctx = (log = vi.fn()) => ({ signal: new AbortController().signal, deadline: Date.now() + 60_000, log, config: null, job: { id: "job-1", key: "files.cleanup" } })

  it("is registered daily with a budget", () => {
    expect(job).toMatchObject({ defaultSchedule: "15 4 * * *", budgetMs: 60_000 })
  })

  it("summarizes what it deleted, and fails loudly when stored copies are left behind", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(fake.now())
    try {
      const { setJackFileStore } = await import("@/server/jack/decks/storage")
      setJackFileStore(store)
      expect(await job.run(ctx())).toEqual({ summary: "Nothing to clean up", counts: { files: 0, objects: 0, leftovers: 0 } })
      file("a", 10 * DAY, { status: "FAILED" })
      expect(await job.run(ctx())).toEqual({ summary: "Deleted 1 unsent file (1 stored copy)", counts: { files: 1, objects: 1, leftovers: 0 } })
      await store.put(`rooms/${ROOM}/77777777-7777-4777-8777-777777777777/late.pdf`, Buffer.from("%PDF"), "application/pdf")
      vi.setSystemTime(fake.now().getTime() + 2 * DAY)
      expect(await job.run(ctx())).toEqual({ summary: "Removed 1 leftover stored file", counts: { files: 0, objects: 0, leftovers: 1 } })
      file("b", 10 * DAY, { status: "FAILED" })
      vi.spyOn(console, "error").mockImplementation(() => {})
      store.delete = async () => {
        throw new Error("storage down")
      }
      await expect(job.run(ctx())).rejects.toThrow("couldn't delete 1 of their stored copies")
      setJackFileStore(null)
    } finally {
      vi.useRealTimers()
    }
  })
})
