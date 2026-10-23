import sharp from "sharp"
import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  galleryAlbum: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  galleryImage: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
  jackFile: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/cache/revalidate-public", () => ({ revalidatePaths: vi.fn() }))
vi.mock("@/server/jack/decks/renders", () => ({ getRenderFile: vi.fn() }))

import type { DeckView } from "@/server/jack/decks/service"
import { addToGallery, describeGalleryAdd, GalleryAlbumGone, galleryPublicId, type GalleryDeps, type GalleryItem } from "./gallery"

const deck: DeckView = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "GM 2 recap",
  size: "post",
  version: 2,
  roomId: "room-1",
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  content: { css: "", slides: [{ id: "s1", html: "<section>1</section>" }, { id: "s2", html: "<section>2</section>" }] },
}
const slideItem = (n: number): GalleryItem => ({ rowId: `slide:s${n}`, kind: "slide", deck, slide: { ...deck.content.slides[n - 1], n }, alt: `GM 2 recap, slide ${n}` })
const photoItem: GalleryItem = { rowId: "file:f1", kind: "file", fileId: "f1", roomId: "room-1", alt: "podium" }

let deps: GalleryDeps & { uploads: { publicId: string; format?: string }[]; removed: string[] }
let images: { id: string; publicId: string; albumId: string; order: number; alt: string }[]
/** Public ids Cloudinary already has (an upload of one answers `existing`) */
let onCloudinary: Set<string>

beforeEach(async () => {
  vi.clearAllMocks()
  images = []
  onCloudinary = new Set()
  const png = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#222" } }).png().toBuffer()
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#555" } }).jpeg().toBuffer()
  const uploads: { publicId: string; format?: string }[] = []
  const removed: string[] = []
  deps = {
    uploads,
    removed,
    slidePng: async () => png,
    readStored: async (path) => (path === "rooms/room-1/f1/derived/model.jpg" ? jpeg : null),
    upload: async (body, publicId) => {
      uploads.push({ publicId, format: (await sharp(body).metadata()).format })
      const existing = onCloudinary.has(publicId)
      onCloudinary.add(publicId)
      return { publicId, width: 1080, height: 1350, existing }
    },
    remove: async (publicId) => {
      removed.push(publicId)
      return onCloudinary.delete(publicId)
    },
  }
  db.$transaction.mockImplementation(async (work: (tx: typeof db) => unknown) => work(db))
  db.galleryAlbum.findUnique.mockResolvedValue({ id: "album-1", title: "GM 2", slug: "gm-2" })
  db.galleryAlbum.findFirst.mockResolvedValue(null)
  db.galleryAlbum.create.mockImplementation(async ({ data }: { data: { title: string; slug: string } }) => ({ id: "album-new", title: data.title, slug: data.slug }))
  db.galleryImage.findMany.mockResolvedValue([])
  db.galleryImage.findUnique.mockResolvedValue(null)
  db.galleryImage.aggregate.mockResolvedValue({ _max: { order: 6 } })
  db.galleryImage.create.mockImplementation(async ({ data }: { data: (typeof images)[number] }) => {
    const row = { ...data, id: `img-${images.length + 1}` }
    images.push(row)
    return { id: row.id }
  })
  db.jackFile.findFirst.mockImplementation(async ({ where }: { where: { id: string; roomId: string } }) => (where.id === "f1" && where.roomId === "room-1" ? { modelCopyPath: "rooms/room-1/f1/derived/model.jpg" } : null))
})

describe("addToGallery", () => {
  it("puts slides (as JPEGs) and a room photo's stripped copy at the end of an album, and audits it", async () => {
    const result = await addToGallery({ target: { albumId: "album-1" }, items: [slideItem(1), photoItem], actorUserId: "u2", auditMetadata: { via: "jack", proposalId: "p1" } }, deps)

    // Uploaded a few at a time, so in any order; the rows keep the order picked
    expect(deps.uploads).toHaveLength(2)
    expect(deps.uploads).toEqual(
      expect.arrayContaining([
        { publicId: galleryPublicId(slideItem(1)), format: "jpeg" },
        { publicId: "gallery/jack/file-f1", format: "jpeg" },
      ]),
    )
    expect(galleryPublicId(slideItem(1))).toMatch(/^gallery\/jack\/[0-9a-f]{40}$/)
    expect(images).toEqual([
      expect.objectContaining({ albumId: "album-1", alt: "GM 2 recap, slide 1", order: 7, publicId: galleryPublicId(slideItem(1)) }),
      expect.objectContaining({ albumId: "album-1", alt: "podium", order: 8, publicId: "gallery/jack/file-f1" }),
    ])
    expect(db.jackFile.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "f1", roomId: "room-1", kind: "IMAGE", status: "READY", messageId: { not: null } } }))
    expect(result).toEqual({ album: { id: "album-1", title: "GM 2", slug: "gm-2", created: false }, added: [{ rowId: "slide:s1", imageId: "img-1" }, { rowId: "file:f1", imageId: "img-2" }], already: [], missing: [] })
    expect(audit.createAuditLog).toHaveBeenCalledTimes(1)
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "u2", actionType: "CREATE", entityType: "GALLERY_IMAGE", entityId: "BATCH", summary: 'Added 2 images to gallery album "GM 2"', metadata: { via: "jack", proposalId: "p1" } })
    expect(describeGalleryAdd(result)).toBe("Added 2 images to the gallery album “GM 2”.")
  })

  it("makes a new album with a free slug, and audits it", async () => {
    db.galleryAlbum.findFirst.mockImplementation(async ({ where }: { where: { slug: string } }) => (where.slug === "gm-2-graphics" ? { id: "taken" } : null))
    const result = await addToGallery({ target: { newAlbum: { title: "GM 2 graphics", date: "2026-10-19" } }, items: [slideItem(2)], actorUserId: "u2", auditMetadata: {} }, deps)
    expect(db.galleryAlbum.create).toHaveBeenCalledWith(expect.objectContaining({ data: { title: "GM 2 graphics", slug: "gm-2-graphics-2", date: new Date("2026-10-19T12:00:00Z") } }))
    expect(result.album).toEqual({ id: "album-new", title: "GM 2 graphics", slug: "gm-2-graphics-2", created: true })
    expect(audit.createAuditLog.mock.calls.map((call) => call[0].entityType)).toEqual(["GALLERY_ALBUM", "GALLERY_IMAGE"])
    expect(describeGalleryAdd(result)).toBe("Added 1 image to the gallery album “GM 2 graphics” (a new album).")
  })

  it("never adds the same slide twice, and skips a photo deleted since", async () => {
    db.galleryImage.findMany.mockResolvedValue([{ publicId: galleryPublicId(slideItem(1)), album: { title: "Older album" } }])
    const gone: GalleryItem = { ...photoItem, rowId: "file:f9", fileId: "f9" } as GalleryItem
    const result = await addToGallery({ target: { albumId: "album-1" }, items: [slideItem(1), gone], actorUserId: "u2", auditMetadata: {} }, deps)
    expect(deps.uploads).toEqual([])
    expect(result).toMatchObject({ added: [], already: [{ rowId: "slide:s1", albumTitle: "Older album" }], missing: ["file:f9"] })
    expect(audit.createAuditLog).not.toHaveBeenCalled()
    expect(describeGalleryAdd(result)).toBe("Nothing new was added to “GM 2”. 1 image was already in the gallery. 1 photo was deleted from the room since, so it wasn't added.")
  })

  it("stops when the album was deleted", async () => {
    db.galleryAlbum.findUnique.mockResolvedValue(null)
    await expect(addToGallery({ target: { albumId: "album-1" }, items: [slideItem(1)], actorUserId: "u2", auditMetadata: {} }, deps)).rejects.toThrow(GalleryAlbumGone)
    expect(deps.uploads).toEqual([])
  })
})

describe("addToGallery when it fails partway", () => {
  const add = (items: GalleryItem[]) => addToGallery({ target: { newAlbum: { title: "GM 2 graphics", date: null } }, items, actorUserId: "u2", auditMetadata: {} }, deps)

  it("takes the copies it made off Cloudinary when the rows can't be written (a new album's slug taken at the same moment)", async () => {
    // The photo was on Cloudinary before (an earlier add that failed): it isn't this call's to delete
    onCloudinary.add("gallery/jack/file-f1")
    const taken = Object.assign(new Error("Unique constraint failed on the fields: (`slug`)"), { code: "P2002" })
    db.$transaction.mockRejectedValue(taken)
    await expect(add([slideItem(1), slideItem(2), photoItem])).rejects.toBe(taken)
    expect(deps.removed.sort()).toEqual([galleryPublicId(slideItem(1)), galleryPublicId(slideItem(2))].sort())
    expect([...onCloudinary]).toEqual(["gallery/jack/file-f1"])
    expect(images).toEqual([])
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("waits for the other uploads when one fails, then takes those copies off too, and writes nothing", async () => {
    const upload = deps.upload
    deps.upload = async (body, publicId) => {
      if (publicId === galleryPublicId(slideItem(2))) throw new Error("Cloudinary didn't take the image (500)")
      // The others finish after the failure
      await new Promise((resolve) => setTimeout(resolve, 20))
      return upload(body, publicId)
    }
    await expect(add([slideItem(1), slideItem(2), photoItem])).rejects.toThrow("Cloudinary didn't take the image (500)")
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(deps.removed.sort()).toEqual([galleryPublicId(slideItem(1)), "gallery/jack/file-f1"].sort())
    expect(onCloudinary.size).toBe(0)
  })

  it("leaves a copy a gallery row uses by now (another officer added the same image meanwhile), and every copy when it can't check", async () => {
    db.$transaction.mockRejectedValue(new Error("Foreign key constraint violated: GalleryImage_albumId_fkey"))
    // inGallery's read finds nothing; by the cleanup's, another officer's row has the slide
    db.galleryImage.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ publicId: galleryPublicId(slideItem(1)) }])
    await expect(add([slideItem(1), photoItem])).rejects.toThrow(/Foreign key/)
    expect(deps.removed).toEqual(["gallery/jack/file-f1"])

    const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
    deps.removed.length = 0
    onCloudinary.clear()
    db.galleryImage.findMany.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Can't reach database server"))
    await expect(add([slideItem(1), photoItem])).rejects.toThrow(/Foreign key/)
    expect(deps.removed).toEqual([])
    expect(quiet).toHaveBeenCalledWith(expect.stringMatching(/couldn't check its 2 copies on Cloudinary, so they stay/), expect.any(Error))
    quiet.mockRestore()
  })
})
