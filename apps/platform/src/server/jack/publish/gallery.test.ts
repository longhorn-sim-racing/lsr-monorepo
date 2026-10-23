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

let deps: GalleryDeps & { uploads: { publicId: string; format?: string }[] }
let images: { id: string; publicId: string; albumId: string; order: number; alt: string }[]

beforeEach(async () => {
  vi.clearAllMocks()
  images = []
  const png = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#222" } }).png().toBuffer()
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#555" } }).jpeg().toBuffer()
  const uploads: { publicId: string; format?: string }[] = []
  deps = {
    uploads,
    slidePng: async () => png,
    readStored: async (path) => (path === "rooms/room-1/f1/derived/model.jpg" ? jpeg : null),
    upload: async (body, publicId) => {
      uploads.push({ publicId, format: (await sharp(body).metadata()).format })
      return { publicId, width: 1080, height: 1350 }
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
