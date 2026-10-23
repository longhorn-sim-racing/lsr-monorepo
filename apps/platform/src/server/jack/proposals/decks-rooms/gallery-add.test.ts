import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  galleryAlbum: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  jackFile: { findMany: vi.fn() },
}))
const decks = vi.hoisted(() => ({ getDeck: vi.fn() }))
const gallery = vi.hoisted(() => ({ addToGallery: vi.fn(), inGallery: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/jack/decks/service", async (original) => ({ ...(await original<typeof import("@/server/jack/decks/service")>()), getDeck: decks.getDeck }))
vi.mock("@/server/jack/publish/gallery", async (original) => ({ ...(await original<typeof import("@/server/jack/publish/gallery")>()), ...gallery }))
vi.mock("@/server/jack/decks/renders", () => ({ getRenderFile: vi.fn() }))

import { GalleryAlbumGone, galleryPublicId } from "@/server/jack/publish/gallery"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { galleryAddKind, galleryAddSchema } from "./gallery-add"

const DECK_ID = "11111111-1111-4111-8111-111111111111"
const FILE = "22222222-2222-4222-8222-222222222222"
const DECK = {
  id: DECK_ID,
  title: "GM 2 recap",
  size: "post" as const,
  version: 3,
  roomId: "room-1",
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  content: { css: "", slides: ["a", "b"].map((id) => ({ id: `slide-${id}`, html: `<section>${id}</section>` })) },
}
const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const meta = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" }
const applyCtx = (before: unknown, selectedRows?: string[]): ProposalApplyContext => ({ officer: { userId: "u2", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: meta, selectedRows })
const payload = (p: Record<string, unknown>) => galleryAddSchema.parse(p)

beforeEach(() => {
  vi.clearAllMocks()
  decks.getDeck.mockImplementation(async (id: string, version?: number) => (id === DECK_ID && (version === undefined || version === 3) ? DECK : null))
  db.galleryAlbum.findFirst.mockImplementation(async ({ where }: { where: { OR?: { id?: string; slug?: string }[]; title?: { equals: string } } }) => {
    if (where.OR?.some((w) => w.id === "album-1" || w.slug === "gm-2")) return { id: "album-1", title: "GM 2", slug: "gm-2" }
    if (where.title?.equals.toLowerCase() === "gm 2") return { id: "album-1", title: "GM 2", slug: "gm-2" }
    return null
  })
  db.galleryAlbum.findMany.mockResolvedValue([{ title: "GM 2" }, { title: "Season 2 awards" }])
  db.galleryAlbum.findUnique.mockResolvedValue({ id: "album-1" })
  db.jackFile.findMany.mockResolvedValue([{ id: FILE, filename: "podium.jpg" }])
  gallery.inGallery.mockResolvedValue(new Map())
})

describe("gallery.add: proposing", () => {
  it("lists every slide and room photo as a row with its picture, for an existing album found by title", async () => {
    const prepared = await galleryAddKind.prepare(payload({ album: "gm 2", deck: DECK_ID, files: [FILE] }), ctx)
    expect(prepared.before).toEqual({ albumId: "album-1", deck: { id: DECK_ID, version: 3, slideIds: ["slide-a", "slide-b"] }, files: [FILE] })
    expect(prepared.targetId).toBe(`album-1:${DECK_ID}`)
    expect(prepared.view.title).toBe("Add 3 images to the gallery (“GM 2”)")
    expect(prepared.view.summary).toBe("Applying it puts the images checked below in the album “GM 2” on the public gallery (/gallery). Any can be taken off again on Gallery.")
    expect(prepared.view.rows).toEqual([
      { id: "slide:slide-a", label: "Slide 1 of “GM 2 recap”", detail: "Alt text: GM 2 recap, slide 1", thumbUrl: `/api/admin/jack/decks/${DECK_ID}/slides/slide-a?v=3&kind=thumb` },
      { id: "slide:slide-b", label: "Slide 2 of “GM 2 recap”", detail: "Alt text: GM 2 recap, slide 2", thumbUrl: `/api/admin/jack/decks/${DECK_ID}/slides/slide-b?v=3&kind=thumb` },
      { id: `file:${FILE}`, label: "podium.jpg", detail: "Alt text: podium", thumbUrl: `/api/admin/jack/files/${FILE}?variant=thumb` },
    ])
    // Only this room's posted, ready photos
    expect(db.jackFile.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [FILE] }, roomId: "room-1", kind: "IMAGE", status: "READY", messageId: { not: null } } }))
    expect(galleryAddKind).toMatchObject({ tool: "propose_deck_publish", permission: "officer" })
    expect(galleryAddKind.destructive).toBeUndefined()
  })

  it("leaves images already in the gallery off the card and out of what applying adds, saying so, and refuses when they all are", async () => {
    gallery.inGallery.mockImplementation(async (ids: string[]) => new Map([[ids[0], "Older album"]]))
    const prepared = await galleryAddKind.prepare(payload({ album: "gm-2", deck: DECK_ID, files: [FILE] }), ctx)
    expect(prepared.view.rows!.map((row) => row.id)).toEqual(["slide:slide-b", `file:${FILE}`])
    expect(prepared.view.rows!.every((row) => row.status === undefined)).toBe(true)
    expect(prepared.view.title).toBe("Add 2 images to the gallery (“GM 2”)")
    expect(prepared.view.summary).toMatch(/Any can be taken off again on Gallery\. 1 more is already in the gallery \(in “Older album”\) and isn't added again\.$/)
    expect(prepared.before).toEqual({ albumId: "album-1", deck: { id: DECK_ID, version: 3, slideIds: ["slide-b"] }, files: [FILE] })
    expect(prepared.targetId).toBe(`album-1:${DECK_ID}`)

    // Every slide there: only the photo is left, and the deck isn't pinned
    gallery.inGallery.mockImplementation(async (ids: string[]) => new Map(ids.filter((id) => !id.includes("file-")).map((id) => [id, null])))
    const photoOnly = await galleryAddKind.prepare(payload({ album: "gm-2", deck: DECK_ID, files: [FILE] }), ctx)
    expect(photoOnly.before).toEqual({ albumId: "album-1", deck: null, files: [FILE] })
    expect(photoOnly.view.summary).toMatch(/ 2 more are already in the gallery and aren't added again\.$/)

    gallery.inGallery.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, null])))
    await expect(galleryAddKind.prepare(payload({ album: "gm-2", deck: DECK_ID }), ctx)).rejects.toThrow("Those images are already in the gallery.")
  })

  it("refuses input Jack can fix: an unknown album, a new album that exists, another room's photo, neither or both albums", async () => {
    await expect(galleryAddKind.prepare(payload({ album: "Nope", deck: DECK_ID }), ctx)).rejects.toThrow(new ProposalInputError("There's no gallery album called “Nope”. Recent albums: “GM 2”, “Season 2 awards”. Ask which one, or use newAlbum if the officer wants a new album."))
    await expect(galleryAddKind.prepare(payload({ newAlbum: { title: "GM 2" }, deck: DECK_ID }), ctx)).rejects.toThrow("An album called “GM 2” already exists.")
    db.jackFile.findMany.mockResolvedValue([])
    await expect(galleryAddKind.prepare(payload({ album: "gm 2", files: [FILE] }), ctx)).rejects.toThrow(`${FILE} isn't a photo posted in this room.`)
    expect(galleryAddSchema.safeParse({ deck: DECK_ID }).success).toBe(false)
    expect(galleryAddSchema.safeParse({ album: "a", newAlbum: { title: "b" }, deck: DECK_ID }).success).toBe(false)
    expect(galleryAddSchema.safeParse({ album: "a" }).success).toBe(false)
    expect(galleryAddSchema.safeParse({ album: "a", files: [FILE], slides: [1] }).success).toBe(false)
  })

  it("can make a new album", async () => {
    const prepared = await galleryAddKind.prepare(payload({ newAlbum: { title: "GM 2 graphics", date: "2026-10-19" }, deck: DECK_ID, slides: [2] }), ctx)
    expect(prepared.before).toEqual({ albumId: null, deck: { id: DECK_ID, version: 3, slideIds: ["slide-b"] }, files: [] })
    expect(prepared.targetId).toBeUndefined()
    expect(prepared.view.summary).toContain("a new album “GM 2 graphics” (2026-10-19)")
  })
})

describe("gallery.add: applying", () => {
  const before = { albumId: "album-1", deck: { id: DECK_ID, version: 3, slideIds: ["slide-a", "slide-b"] }, files: [FILE] }

  it("adds only the rows officers left ticked, as the applying officer", async () => {
    gallery.addToGallery.mockResolvedValue({ album: { id: "album-1", title: "GM 2", slug: "gm-2", created: false }, added: [{ rowId: "slide:slide-b", imageId: "img-1" }, { rowId: `file:${FILE}`, imageId: "img-2" }], already: [], missing: [] })
    const result = await galleryAddKind.apply(payload({ album: "gm 2", deck: DECK_ID, files: [FILE] }), applyCtx(before, ["slide:slide-b", `file:${FILE}`]))
    const [request] = gallery.addToGallery.mock.calls[0]
    expect(request).toMatchObject({ target: { albumId: "album-1" }, actorUserId: "u2", auditMetadata: meta })
    expect(request.items.map((i: { rowId: string; alt: string }) => [i.rowId, i.alt])).toEqual([
      ["slide:slide-b", "GM 2 recap, slide 2"],
      [`file:${FILE}`, "podium"],
    ])
    expect(result).toEqual({
      summary: "Added 2 images to the gallery album “GM 2”.",
      links: [
        { title: "Gallery", url: "/admin/gallery" },
        { title: "The public gallery", url: "/gallery" },
      ],
      created: [
        { type: "GALLERY_IMAGE", id: "img-1" },
        { type: "GALLERY_IMAGE", id: "img-2" },
      ],
      appliedRows: ["slide:slide-b", `file:${FILE}`],
      counts: { added: 2, already: 0, missing: 0 },
    })
    expect(galleryPublicId(request.items[1])).toBe(`gallery/jack/file-${FILE}`)
  })

  it("makes the new album when applied, and goes stale when the album or the deck is gone", async () => {
    gallery.addToGallery.mockResolvedValue({ album: { id: "album-new", title: "GM 2 graphics", slug: "gm-2-graphics", created: true }, added: [{ rowId: "slide:slide-b", imageId: "img-1" }], already: [], missing: [] })
    const fresh = await galleryAddKind.apply(payload({ newAlbum: { title: "GM 2 graphics" }, deck: DECK_ID, slides: [2] }), applyCtx({ albumId: null, deck: { id: DECK_ID, version: 3, slideIds: ["slide-b"] }, files: [] }))
    expect(gallery.addToGallery.mock.calls[0][0].target).toEqual({ newAlbum: { title: "GM 2 graphics", date: null } })
    expect(fresh.created).toEqual([{ type: "GALLERY_ALBUM", id: "album-new" }, { type: "GALLERY_IMAGE", id: "img-1" }])

    gallery.addToGallery.mockRejectedValue(new GalleryAlbumGone())
    await expect(galleryAddKind.apply(payload({ album: "gm 2", deck: DECK_ID }), applyCtx(before))).rejects.toThrow(StaleProposalError)
    await expect(galleryAddKind.apply(payload({ album: "gm 2", deck: DECK_ID }), applyCtx({ ...before, deck: { ...before.deck, version: 9 } }))).rejects.toThrow(StaleProposalError)

    db.galleryAlbum.findUnique.mockResolvedValue(null)
    expect(await galleryAddKind.checkStale(payload({ album: "gm 2", deck: DECK_ID }), before)).toBe("The album was deleted since this was proposed.")
  })
})
