import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  jackFile: { groupBy: vi.fn(), count: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { fileStore, setJackFileStore, type JackFileStore } from "@/server/jack/decks/storage"
import { formatStorageBytes, getStorageUsage, readBucketUsage, roomFileCounts, storageFill, SUPABASE_FREE_STORAGE_BYTES } from "./usage"

/** A store of the given kind; the usage never calls it */
const storeOf = (kind: JackFileStore["kind"]): JackFileStore => ({ ...fileStore("unused"), kind })

/** The SQL of each raw query, in order */
const sqlOf = () => db.$queryRaw.mock.calls.map((call) => (call[0] as TemplateStringsArray).join("?"))

beforeEach(() => {
  db.jackFile.groupBy.mockResolvedValue([
    { status: "READY", _count: { _all: 4 }, _sum: { sizeBytes: 3_500_000 } },
    { status: "UPLOADING", _count: { _all: 1 }, _sum: { sizeBytes: 900 } },
  ])
  db.jackFile.count.mockResolvedValue(2)
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => setJackFileStore(null))

describe("readBucketUsage", () => {
  it("reads the bucket's settings and size from Storage's tables, with the other buckets apart", async () => {
    db.$queryRaw
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ public: false, fileSizeLimit: BigInt(50_000_000) }])
      .mockResolvedValueOnce([
        { mine: true, objects: 12, bytes: BigInt(120_000_000) },
        { mine: false, objects: 3, bytes: BigInt(5_000_000) },
      ])
    expect(await readBucketUsage()).toEqual({ exists: true, public: false, fileSizeLimit: 50_000_000, objects: 12, bytes: 120_000_000, otherBytes: 5_000_000 })
    const [present, buckets, objects] = sqlOf()
    expect(present).toContain("to_regclass('storage.objects')")
    expect(buckets).toContain("FROM storage.buckets WHERE id = ?")
    expect(objects).toContain("FROM storage.objects GROUP BY 1")
    // Only numeric sizes are summed
    expect(objects).toContain("metadata->>'size' ~ '^[0-9]+$'")
    expect(db.$queryRaw.mock.calls[1].slice(1)).toEqual(["jack"])
  })

  it("says when the bucket isn't there, and counts an empty one as nothing stored", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    expect(await readBucketUsage()).toEqual({ exists: false, public: false, fileSizeLimit: null, objects: 0, bytes: 0, otherBytes: 0 })
  })

  it("is null without Storage's tables, or when they can't be read, instead of failing the page", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ present: false }])
    expect(await readBucketUsage()).toBeNull()
    expect(db.$queryRaw).toHaveBeenCalledTimes(1)

    db.$queryRaw.mockResolvedValueOnce([{ present: true }]).mockRejectedValueOnce(new Error("permission denied for schema storage"))
    expect(await readBucketUsage()).toBeNull()
    expect(console.error).toHaveBeenCalledWith("[jack] Couldn't read Storage usage:", "permission denied for schema storage")
  })
})

describe("roomFileCounts", () => {
  it("counts room files by status, what the ready ones hold, and the ones never posted", async () => {
    expect(await roomFileCounts()).toEqual({ uploading: 1, ready: 4, failed: 0, readyBytes: 3_500_000, unposted: 2 })
    expect(db.jackFile.count).toHaveBeenCalledWith({ where: { status: "READY", messageId: null } })
  })
})

describe("getStorageUsage", () => {
  it("reads the bucket only on Supabase Storage", async () => {
    setJackFileStore(storeOf("files"))
    expect(await getStorageUsage()).toEqual({ kind: "files", bucket: null, files: expect.objectContaining({ ready: 4 }) })
    setJackFileStore(storeOf("none"))
    expect((await getStorageUsage()).kind).toBe("none")
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it("on Supabase, gives the bucket's usage, or says why it's missing", async () => {
    setJackFileStore(storeOf("supabase"))
    db.$queryRaw.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([{ public: false, fileSizeLimit: null }]).mockResolvedValueOnce([{ mine: true, objects: 1, bytes: 10 }])
    expect(await getStorageUsage()).toMatchObject({ kind: "supabase", bucket: { exists: true, objects: 1, bytes: 10 } })

    db.$queryRaw.mockResolvedValueOnce([{ present: false }])
    expect(await getStorageUsage()).toMatchObject({ kind: "supabase", bucket: null, bucketError: expect.stringContaining("storage.objects") })
  })
})

describe("formatStorageBytes and storageFill", () => {
  it("shows sizes in decimal units, like the plan's limits", () => {
    expect(formatStorageBytes(0)).toBe("0 B")
    expect(formatStorageBytes(999)).toBe("999 B")
    expect(formatStorageBytes(840_000)).toBe("840 KB")
    expect(formatStorageBytes(12_500_000)).toBe("12.5 MB")
    expect(formatStorageBytes(50_000_000)).toBe("50 MB")
    expect(formatStorageBytes(SUPABASE_FREE_STORAGE_BYTES)).toBe("1 GB")
    expect(formatStorageBytes(1_024_000_000)).toBe("1.02 GB")
  })

  it("warns at 80% of the plan and calls 95% a danger", () => {
    expect(storageFill(100_000_000)).toEqual({ share: 0.1, tone: "success" })
    expect(storageFill(800_000_000).tone).toBe("warning")
    expect(storageFill(950_000_000).tone).toBe("danger")
    expect(storageFill(1_200_000_000)).toEqual({ share: 1.2, tone: "danger" })
  })
})
