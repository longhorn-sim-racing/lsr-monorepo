import sharp from "sharp"
import { createAuditLog } from "@/server/audit/log"
import { uploadImageBytes } from "@/server/cloudinary"
import { prisma } from "@/server/db"
import { renderKey, type SlideSource } from "@/server/jack/decks/document"
import { getRenderFile } from "@/server/jack/decks/renders"
import type { DeckView } from "@/server/jack/decks/service"
import { jackFileStore } from "@/server/jack/decks/storage"
import { mapLimit, plural, revalidate } from "@/server/jack/proposals/changes/shared"
import { nextGalleryOrder, uniqueAlbumSlug } from "@/server/services/gallery.service"
import { slideImage, slideSource, type PickedSlide } from "./slides"

/**
 * Adding deck slides and room photos to the public gallery (#188, design §4.3 gallery.add): a
 * gallery.add proposal's Apply, or the deck page's "Add to gallery" button. Each image goes to
 * Cloudinary under a name made from what it is (a slide's render key, a room photo's file id), so the
 * same slide or photo is never added twice: one already there is reported, not copied again. Room photos
 * go as their model copy (JPEG, long edge ≤2000 px, every bit of metadata stripped, so no location from
 * a phone's EXIF), slides as a JPEG of their full-size render. The GalleryImage rows, and the album when
 * it's new, are written in one transaction, then audited and the gallery pages refreshed, as the
 * Gallery page's own uploads are.
 */

export type GalleryItem =
  | { rowId: string; kind: "slide"; deck: DeckView; slide: PickedSlide; alt: string }
  | { rowId: string; kind: "file"; fileId: string; roomId: string; alt: string }

export type GalleryTarget = { albumId: string } | { newAlbum: { title: string; date: string | null } }

export type GalleryAddResult = {
  album: { id: string; title: string; slug: string; created: boolean }
  added: { rowId: string; imageId: string }[]
  /** Already in the gallery (in this album or another) */
  already: { rowId: string; albumTitle: string | null }[]
  /** Gone since it was picked (a deleted room photo) */
  missing: string[]
}

/** The album a gallery.add was going to fill was deleted */
export class GalleryAlbumGone extends Error {
  constructor() {
    super("The album was deleted since this was picked. Pick another album.")
    this.name = "GalleryAlbumGone"
  }
}

export type GalleryDeps = {
  slidePng(source: SlideSource): Promise<Buffer>
  readStored(path: string): Promise<Buffer | null>
  upload(body: Buffer, publicId: string): Promise<{ publicId: string; width: number | null; height: number | null }>
}

export const galleryDeps: GalleryDeps = {
  slidePng: async (source) => (await getRenderFile(source, "png")).body,
  readStored: (path) => jackFileStore().get(path),
  upload: (body, publicId) => uploadImageBytes(body, { publicId, filename: "gallery.jpg", contentType: "image/jpeg" }),
}

/** The Cloudinary public id an item goes to: the same slide or photo always gets the same one */
export function galleryPublicId(item: GalleryItem): string {
  return item.kind === "slide" ? `gallery/jack/${renderKey(slideSource(item.deck, item.slide))}` : `gallery/jack/file-${item.fileId}`
}

/** Which of these are in the gallery already, by public id, with their album's title */
export async function inGallery(publicIds: string[]): Promise<Map<string, string | null>> {
  if (!publicIds.length) return new Map()
  const rows = await prisma.galleryImage.findMany({ where: { publicId: { in: publicIds } }, select: { publicId: true, album: { select: { title: true } } } })
  return new Map(rows.map((row) => [row.publicId, row.album?.title ?? null]))
}

/** A room photo's copy: only a ready photo posted in that room */
async function roomPhoto(fileId: string, roomId: string, deps: GalleryDeps): Promise<Buffer | null> {
  const file = await prisma.jackFile.findFirst({ where: { id: fileId, roomId, kind: "IMAGE", status: "READY", messageId: { not: null } }, select: { modelCopyPath: true } })
  return file?.modelCopyPath ? deps.readStored(file.modelCopyPath) : null
}

export async function addToGallery(
  input: { target: GalleryTarget; items: GalleryItem[]; actorUserId: string; auditMetadata: Record<string, unknown> },
  deps: GalleryDeps = galleryDeps,
): Promise<GalleryAddResult> {
  const existingAlbum = "albumId" in input.target ? await prisma.galleryAlbum.findUnique({ where: { id: input.target.albumId }, select: { id: true, title: true, slug: true } }) : null
  if ("albumId" in input.target && !existingAlbum) throw new GalleryAlbumGone()

  const ids = new Map(input.items.map((item) => [item.rowId, galleryPublicId(item)]))
  const there = await inGallery([...ids.values()])
  const already = input.items.filter((item) => there.has(ids.get(item.rowId)!)).map((item) => ({ rowId: item.rowId, albumTitle: there.get(ids.get(item.rowId)!) ?? null }))
  const todo = input.items.filter((item) => !there.has(ids.get(item.rowId)!))

  // The images onto Cloudinary, a few at a time
  const missing: string[] = []
  const uploaded = (
    await mapLimit(todo, 3, async (item) => {
      const bytes = item.kind === "slide" ? await sharp(await slideImage(deps, item.deck, item.slide)).jpeg({ quality: 88, mozjpeg: true }).toBuffer() : await roomPhoto(item.fileId, item.roomId, deps)
      if (!bytes) {
        missing.push(item.rowId)
        return null
      }
      const image = await deps.upload(bytes, ids.get(item.rowId)!)
      return { item, image }
    })
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  // The album (when it's new) and the rows, at the end of the album in the order picked
  const written = await prisma.$transaction(async (tx) => {
    const album = existingAlbum
      ? { ...existingAlbum, created: false }
      : "newAlbum" in input.target
        ? {
            ...(await tx.galleryAlbum.create({
              data: { title: input.target.newAlbum.title, date: input.target.newAlbum.date ? new Date(`${input.target.newAlbum.date}T12:00:00Z`) : null, slug: await uniqueAlbumSlug(input.target.newAlbum.title, undefined, tx) },
              select: { id: true, title: true, slug: true },
            })),
            created: true,
          }
        : null
    if (!album) throw new Error("No album to add to")
    let order = await nextGalleryOrder(album.id, tx)
    const added: { rowId: string; imageId: string; publicId: string }[] = []
    for (const { item, image } of uploaded) {
      // Added meanwhile (another officer, the same slide): leave it where it is
      if (await tx.galleryImage.findUnique({ where: { publicId: image.publicId }, select: { id: true } })) {
        already.push({ rowId: item.rowId, albumTitle: null })
        continue
      }
      const row = await tx.galleryImage.create({ data: { publicId: image.publicId, albumId: album.id, alt: item.alt, width: image.width, height: image.height, order: order++ }, select: { id: true } })
      added.push({ rowId: item.rowId, imageId: row.id, publicId: image.publicId })
    }
    return { album, added }
  })

  const { album, added } = written
  if (album.created) {
    await createAuditLog({ actorUserId: input.actorUserId, actionType: "CREATE", entityType: "GALLERY_ALBUM", entityId: album.id, summary: `Created gallery album "${album.title}"`, after: album, metadata: input.auditMetadata })
  }
  if (added.length) {
    await createAuditLog({
      actorUserId: input.actorUserId,
      actionType: "CREATE",
      entityType: "GALLERY_IMAGE",
      entityId: added.length === 1 ? added[0].imageId : "BATCH",
      summary: `Added ${plural(added.length, "image")} to gallery album "${album.title}"`,
      after: { albumId: album.id, images: added.map((a) => ({ id: a.imageId, publicId: a.publicId })) },
      metadata: input.auditMetadata,
    })
  }
  revalidate(["/admin/gallery", "/gallery", "/"])
  return { album, added: added.map(({ rowId, imageId }) => ({ rowId, imageId })), already, missing }
}

/** What adding did, in a sentence */
export function describeGalleryAdd(result: GalleryAddResult): string {
  const parts = [result.added.length ? `Added ${plural(result.added.length, "image")} to the gallery album “${result.album.title}”${result.album.created ? " (a new album)" : ""}.` : `Nothing new was added to “${result.album.title}”.`]
  if (result.already.length) parts.push(`${plural(result.already.length, "image")} ${result.already.length === 1 ? "was" : "were"} already in the gallery.`)
  if (result.missing.length) parts.push(`${plural(result.missing.length, "photo")} ${result.missing.length === 1 ? "was" : "were"} deleted from the room since, so ${result.missing.length === 1 ? "it wasn't" : "they weren't"} added.`)
  return parts.join(" ")
}
