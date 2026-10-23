import { z } from "zod"
import { deckPageUrl, MAX_DECK_SLIDES } from "@/lib/jack/decks"
import { jackFileUrl } from "@/lib/jack/files"
import { prisma } from "@/server/db"
import { getDeck } from "@/server/jack/decks/service"
import { addToGallery, describeGalleryAdd, GalleryAlbumGone, galleryPublicId, inGallery, type GalleryItem, type GalleryTarget } from "@/server/jack/publish/gallery"
import { pickSlides, slidesById, slideThumbUrl } from "@/server/jack/publish/slides"
import { listed, plural } from "../changes/shared"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalKind, ProposalLink, ProposalRow } from "../types"

/**
 * gallery.add (design §4.3): a deck's slides and/or photos posted in this room, into a gallery album
 * (an existing one, or a new one). One row per image, so officers untick any they don't want. The
 * gallery is public (/gallery), but an image can be taken off again on Gallery, so applying doesn't ask
 * twice. Slides are pinned by id at the version proposed; room photos go as their stripped copy (no
 * location from a phone). The same slide or photo is never added twice (src/server/jack/publish/gallery.ts).
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/

export const galleryAddSchema = z
  .object({
    album: z.string().trim().min(1).max(120).optional().describe("An existing gallery album: its title, slug or id. Ask the officer which album when they didn't say"),
    newAlbum: z
      .object({
        title: z.string().trim().min(1).max(120).describe("The new album's title"),
        date: z.string().trim().regex(DATE, "Use a date like 2026-10-19").optional().describe("The day it's from, YYYY-MM-DD (albums sort by it)"),
      })
      .optional()
      .describe("Make a new album instead (only when the officer asked for one)"),
    deck: z.string().trim().min(1).max(64).optional().describe("A deck whose slides to add (its id from deck_view)"),
    version: z.number().int().min(1).optional().describe("The deck version (default: its current one)"),
    slides: z.array(z.number().int().min(1).max(MAX_DECK_SLIDES)).min(1).max(MAX_DECK_SLIDES).optional().describe("Slide numbers to add (default: every slide of the deck)"),
    files: z.array(z.string().trim().min(1).max(64)).min(1).max(40).optional().describe("Photos posted in this room, by file id (room_files lists them)"),
    alt: z.string().trim().min(1).max(300).optional().describe("Alt text for every image added (default: the deck's title and slide number, or the photo's name)"),
  })
  .refine((p) => Boolean(p.album) !== Boolean(p.newAlbum), { message: "Give album (an existing one) or newAlbum, not both.", path: ["album"] })
  .refine((p) => Boolean(p.deck || p.files?.length), { message: "Give a deck's slides (deck) or room photos (files).", path: ["deck"] })
  .refine((p) => p.deck || (p.version === undefined && p.slides === undefined), { message: "version and slides go with deck.", path: ["slides"] })

export type GalleryAddPayload = z.infer<typeof galleryAddSchema>

const savedBefore = z.object({
  albumId: z.string().nullable(),
  deck: z.object({ id: z.string(), version: z.number().int(), slideIds: z.array(z.string()) }).nullable(),
  files: z.array(z.string()),
})

type SavedBefore = z.infer<typeof savedBefore>

/** An existing album by id, slug or title (case doesn't matter), or the error for Jack with a few to pick from */
async function findAlbum(name: string): Promise<{ id: string; title: string; slug: string }> {
  const select = { id: true, title: true, slug: true } as const
  const album =
    (await prisma.galleryAlbum.findFirst({ where: { OR: [{ id: name }, { slug: name.toLowerCase() }] }, select })) ??
    (await prisma.galleryAlbum.findFirst({ where: { title: { equals: name, mode: "insensitive" } }, orderBy: { createdAt: "desc" }, select }))
  if (album) return album
  const recent = await prisma.galleryAlbum.findMany({ orderBy: [{ date: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], take: 8, select: { title: true } })
  throw new ProposalInputError(`There's no gallery album called “${name}”. ${recent.length ? `Recent albums: ${recent.map((a) => `“${a.title}”`).join(", ")}. ` : ""}Ask which one, or use newAlbum if the officer wants a new album.`)
}

/** The room's posted, ready photos by id, or the error for Jack */
async function roomPhotos(roomId: string, ids: string[]) {
  const unique = [...new Set(ids)]
  const found = await prisma.jackFile.findMany({ where: { id: { in: unique }, roomId, kind: "IMAGE", status: "READY", messageId: { not: null } }, select: { id: true, filename: true } })
  const missing = unique.filter((id) => !found.some((f) => f.id === id))
  if (missing.length) throw new ProposalInputError(`${listed(missing)} ${missing.length === 1 ? "isn't a photo" : "aren't photos"} posted in this room. room_files lists this room's photos.`)
  return unique.map((id) => found.find((f) => f.id === id)!)
}

export const galleryAddKind: ProposalKind<GalleryAddPayload> = {
  kind: "gallery.add",
  tool: "propose_deck_publish",
  description:
    "gallery.add: add a deck's slides (deck_view ids and numbers) and/or photos posted in this room (room_files ids) to a gallery album on the public site, an existing album (ask which when the officer didn't say) or a new one. The card lists each image, so officers can untick some.",
  schema: galleryAddSchema,
  targetType: "GALLERY_IMAGE",
  permission: "officer",

  async prepare(p, ctx) {
    const album = p.album ? await findAlbum(p.album) : null
    if (p.newAlbum && (await prisma.galleryAlbum.findFirst({ where: { title: { equals: p.newAlbum.title, mode: "insensitive" } }, select: { id: true } }))) {
      throw new ProposalInputError(`An album called “${p.newAlbum.title}” already exists. Use album to add to it, or pick another title.`)
    }

    const items: GalleryItem[] = []
    const rows: ProposalRow[] = []
    let deckPinned: SavedBefore["deck"] = null
    if (p.deck) {
      const picked = await pickSlides(p.deck, { version: p.version, numbers: p.slides })
      if ("error" in picked) throw new ProposalInputError(picked.error)
      deckPinned = { id: picked.deck.id, version: picked.deck.version, slideIds: picked.slides.map((s) => s.id) }
      for (const slide of picked.slides) {
        const alt = p.alt ?? `${picked.deck.title}, slide ${slide.n}`
        items.push({ rowId: `slide:${slide.id}`, kind: "slide", deck: picked.deck, slide, alt })
        rows.push({ id: `slide:${slide.id}`, label: `Slide ${slide.n} of “${picked.deck.title}”`, detail: `Alt text: ${alt}`, thumbUrl: slideThumbUrl(picked.deck, slide.id) })
      }
    }
    const photos = p.files?.length ? await roomPhotos(ctx.roomId, p.files) : []
    for (const photo of photos) {
      const alt = p.alt ?? photo.filename.replace(/\.[a-z0-9]+$/i, "")
      items.push({ rowId: `file:${photo.id}`, kind: "file", fileId: photo.id, roomId: ctx.roomId, alt })
      rows.push({ id: `file:${photo.id}`, label: photo.filename, detail: `Alt text: ${alt}`, thumbUrl: jackFileUrl(photo.id, "thumb") })
    }

    // Already in the gallery: still listed (the card says so), skipped when applied
    const there = await inGallery(items.map(galleryPublicId))
    items.forEach((item, i) => {
      const albumTitle = there.get(galleryPublicId(item))
      if (albumTitle !== undefined) rows[i] = { ...rows[i], detail: `Already in the gallery${albumTitle ? ` (“${albumTitle}”)` : ""}; it won't be added again`, status: "unmatched" }
    })
    if (rows.every((row) => row.status === "unmatched")) throw new ProposalInputError(`${items.length === 1 ? "That image is" : "Those images are"} already in the gallery.`)

    const where = album ? `the album “${album.title}”` : `a new album “${p.newAlbum!.title}”${p.newAlbum!.date ? ` (${p.newAlbum!.date})` : ""}`
    const links: ProposalLink[] = [...(deckPinned ? [{ title: "The deck", url: deckPageUrl(deckPinned.id) }] : []), { title: "Gallery", url: "/admin/gallery" }]
    return {
      before: { albumId: album?.id ?? null, deck: deckPinned, files: photos.map((f) => f.id) } satisfies SavedBefore,
      ...(album ? { targetId: album.id } : {}),
      view: {
        title: `Add ${plural(items.length, "image")} to the gallery (${album ? `“${album.title}”` : `new album “${p.newAlbum!.title}”`})`.slice(0, 200),
        summary: `Applying it puts the images checked below in ${where} on the public gallery (/gallery). Any can be taken off again on Gallery.`,
        diff: [],
        rows,
        links,
      },
    }
  },

  async checkStale(p, before) {
    const saved = savedBefore.safeParse(before)
    if (!saved.success) return "The proposal's images are missing. Ask Jack to propose it again."
    if (saved.data.albumId && !(await prisma.galleryAlbum.findUnique({ where: { id: saved.data.albumId }, select: { id: true } }))) return "The album was deleted since this was proposed."
    if (saved.data.deck && !(await getDeck(saved.data.deck.id, saved.data.deck.version))) return "The deck was deleted since this was proposed."
    return null
  },

  async apply(p, ctx) {
    const saved = savedBefore.safeParse(ctx.before)
    if (!saved.success) throw new StaleProposalError("The proposal's images are missing. Ask Jack to propose it again.")
    const picks = new Set(ctx.selectedRows ?? [...(saved.data.deck?.slideIds ?? []).map((id) => `slide:${id}`), ...saved.data.files.map((id) => `file:${id}`)])

    const items: GalleryItem[] = []
    if (saved.data.deck) {
      const pinned = await slidesById(saved.data.deck.id, saved.data.deck.version, saved.data.deck.slideIds)
      if (!pinned) throw new StaleProposalError("The deck or one of its slides was deleted since this was proposed.")
      for (const slide of pinned.slides) if (picks.has(`slide:${slide.id}`)) items.push({ rowId: `slide:${slide.id}`, kind: "slide", deck: pinned.deck, slide, alt: p.alt ?? `${pinned.deck.title}, slide ${slide.n}` })
    }
    if (saved.data.files.length) {
      const names = new Map((await prisma.jackFile.findMany({ where: { id: { in: saved.data.files } }, select: { id: true, filename: true } })).map((f) => [f.id, f.filename]))
      for (const fileId of saved.data.files) if (picks.has(`file:${fileId}`)) items.push({ rowId: `file:${fileId}`, kind: "file", fileId, roomId: ctx.roomId, alt: p.alt ?? (names.get(fileId) ?? "Photo").replace(/\.[a-z0-9]+$/i, "") })
    }
    if (!items.length) throw new Error("No images are picked.")

    const target: GalleryTarget = saved.data.albumId ? { albumId: saved.data.albumId } : { newAlbum: { title: p.newAlbum!.title, date: p.newAlbum!.date ?? null } }
    try {
      const result = await addToGallery({ target, items, actorUserId: ctx.officer.userId, auditMetadata: { ...ctx.auditMetadata } })
      return {
        summary: describeGalleryAdd(result),
        links: [{ title: "Gallery", url: "/admin/gallery" }, { title: "The public gallery", url: "/gallery" }],
        created: [...(result.album.created ? [{ type: "GALLERY_ALBUM", id: result.album.id }] : []), ...result.added.map((a) => ({ type: "GALLERY_IMAGE", id: a.imageId }))],
        appliedRows: result.added.map((a) => a.rowId),
        counts: { added: result.added.length, already: result.already.length, missing: result.missing.length },
      }
    } catch (error) {
      if (error instanceof GalleryAlbumGone) throw new StaleProposalError(error.message)
      throw error
    }
  },
}
