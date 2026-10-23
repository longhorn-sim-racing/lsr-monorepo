import type { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"

/**
 * The gallery's slugs and order, shared by the admin page's actions (app/admin/gallery/actions.ts) and
 * Jack's gallery.add (src/server/jack/publish/gallery.ts), so both name albums and place photos the
 * same way.
 */

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Where Jack's gallery adds (and the deck page's) put their copies on Cloudinary: slides and room photos
 * that were officer-only until then. Deleting such a gallery image deletes its copy too
 */
export const JACK_GALLERY_PREFIX = "gallery/jack/"

/** Next order value at the end of an album (or of the unsorted photos). */
export async function nextGalleryOrder(albumId: string | null, db: Db = prisma): Promise<number> {
  const last = await db.galleryImage.aggregate({ where: { albumId }, _max: { order: true } })
  return (last._max.order ?? 0) + 1
}

export function slugifyAlbumTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 60)
      .replace(/^-+|-+$/g, "") || "album"
  )
}

/** /gallery shows photos without an album under this slug */
const RESERVED_SLUGS = new Set(["unsorted"])

/** A slug for an album title no other album has: "gm-2", then "gm-2-2" */
export async function uniqueAlbumSlug(title: string, excludeId?: string, db: Db = prisma): Promise<string> {
  const base = slugifyAlbumTitle(title)
  for (let n = RESERVED_SLUGS.has(base) ? 2 : 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    const taken = await db.galleryAlbum.findFirst({ where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) } })
    if (!taken) return slug
  }
}
