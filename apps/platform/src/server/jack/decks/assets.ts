import { prisma } from "@/server/db"

/**
 * The images Jack may put on slides (#177): the site's own photos and logos (relative paths, served
 * by the public site), and the club's gallery photos on Cloudinary. Only these load in the renderer,
 * besides QR codes; the design guide says never to invent a URL.
 */

export type DeckAsset = {
  /** What a slide puts in src, as is */
  url: string
  /** What it shows */
  about: string
  width: number
  height: number
  group: "photo" | "livery" | "logo" | "sponsor" | "partner" | "gallery"
}

const site = (path: string, width: number, height: number, group: DeckAsset["group"], about: string): DeckAsset => ({ url: path, width, height, group, about })

/** Site photos and logos, from apps/platform/public. Keep in step with the files there */
export const SITE_ASSETS: DeckAsset[] = [
  site("/images/lsr-hero.webp", 3840, 2160, "photo", "The club's orange Mercedes GT3 parked at Le Mans in daylight (the site's hero)"),
  site("/images/lsr-hero2.webp", 3840, 2160, "photo", "The orange Mercedes GT3 from above at speed, past a kerb"),
  site("/images/lsr-hero3.webp", 3840, 2160, "photo", "The white LSR Porsche with a driver in the Daytona paddock, palm trees behind"),
  site("/images/gal_03.jpeg", 3840, 2160, "photo", "The white Porsche racing at night at Daytona, a car behind (good cover)"),
  site("/images/gal_04.jpeg", 3840, 2160, "photo", "The Porsche in a night pit stop (dark; recap and stats slides)"),
  site("/images/gal_05.JPG", 3840, 2160, "photo", "The orange Mercedes in the Le Mans pit lane at night"),
  site("/images/gal_08.jpeg", 2268, 4032, "photo", "Members standing at the sim rigs in a lounge (portrait; people, events, wrap slides)"),
  site("/images/gal_11.jpg", 6184, 3479, "photo", "A dark prototype race car and a tire in a garage hall (dark; 'next steps' slides)"),
  site("/images/liveries/daytona-grid-pair.webp", 1920, 1080, "livery", "The white Porsche and orange Mercedes on the Daytona grid with a driver between them"),
  site("/images/liveries/daytona-porsche-driver.webp", 3840, 2160, "livery", "The Porsche and a driver in the Daytona paddock"),
  site("/images/liveries/le-mans-amg.webp", 3840, 2160, "livery", "The orange Mercedes parked at Le Mans, blue sky"),
  site("/images/liveries/le-mans-amg-pit-exit.webp", 3840, 2160, "livery", "The orange Mercedes leaving the Le Mans pits at night"),
  site("/images/liveries/nurburgring-porsche-golden-hour.webp", 1920, 1080, "livery", "The Porsche at the Nürburgring Karussell, golden hour"),
  site("/images/liveries/nurburgring-amg.webp", 1920, 1080, "livery", "The orange Mercedes at the Karussell, sunset"),
  site("/images/liveries/nurburgring-dusk.webp", 1920, 1080, "livery", "Three cars at dusk under the moon (dark)"),
  site("/images/liveries/nurburgring-porsche-chase.webp", 1920, 1080, "livery", "Chase-cam shot of the Porsche from behind, brake lights on"),
  site("/images/liveries/watkins-glen-turn-5.webp", 1920, 1080, "livery", "Both cars through Turn 5 at Watkins Glen"),
  site("/images/liveries/daytona-night-amg.webp", 1080, 1080, "livery", "The orange Mercedes leading under the lights at Daytona (square)"),
  site("/images/liveries/daytona-night-porsche.webp", 1080, 1080, "livery", "The Porsche at Daytona at night (square, dark)"),
  site("/brand/logos/white_logo.png", 994, 333, "logo", "LSR logo mark, white, transparent background (for dark slides; the chrome already has it)"),
  site("/brand/logos/black_logo.png", 994, 333, "logo", "LSR logo mark, black, transparent background (for light slides)"),
  site("/brand/logos/full_text_only_white.png", 2630, 597, "logo", "\"LONGHORN SIM RACING\" wordmark, white"),
  site("/brand/logos/black_logo_with_full_subtext.png", 1583, 809, "logo", "LSR mark with \"Longhorn Sim Racing, University of Texas at Austin\" under it, black"),
  site("/brand/logos/white_logo_black_square.png", 566, 566, "logo", "White LSR mark on a charcoal square (avatar style)"),
  site("/images/lone-star-cup-logo.png", 509, 218, "logo", "Lone Star Cup (LSC) league logo"),
  site("/sponsors/driventocare.png", 2500, 695, "sponsor", "Driven to Care sponsor logo (dark text, for light backgrounds)"),
  site("/sponsors/driventocare-reversed.png", 2500, 695, "sponsor", "Driven to Care sponsor logo, reversed (for dark backgrounds)"),
  site("/sponsors/pitlane.png", 2048, 471, "sponsor", "Pitlane sponsor logo"),
  site("/sponsors/raceclub.png", 310, 310, "sponsor", "Race Club sponsor logo"),
  site("/sponsors/yugo.png", 800, 800, "sponsor", "Yugo sponsor logo"),
  site("/partners/longhorn-racing.png", 640, 240, "partner", "Longhorn Racing (UT's Formula SAE team) logo"),
  site("/partners/longhorn-baja-racing.png", 567, 148, "partner", "Longhorn Baja Racing logo"),
  site("/partners/longhorn-car-club.png", 477, 320, "partner", "Longhorn Car Club logo"),
  site("/partners/orange-dames.png", 320, 320, "partner", "Orange Dames logo"),
]

const CLOUD_NAME = () => process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME?.trim() || "daklxjoxr"

/** A gallery photo sized for slides: at most 2000 px on its long side, Cloudinary's automatic quality */
export function galleryPhotoUrl(publicId: string) {
  return `https://res.cloudinary.com/${CLOUD_NAME()}/image/upload/c_limit,w_2000,h_2000,q_auto:good/${publicId}`
}

export type GalleryAssetQuery = { query?: string; album?: string; limit?: number }

/** Gallery photos, newest albums first, optionally matching words in the album or the photo's alt text */
export async function findGalleryAssets({ query, album, limit = 30 }: GalleryAssetQuery = {}): Promise<{ assets: (DeckAsset & { album: string | null })[]; albums: { title: string; slug: string; photos: number; date: string | null }[] }> {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter((word) => word.length > 1)
  const albums = await prisma.galleryAlbum.findMany({
    orderBy: [{ date: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: { id: true, title: true, slug: true, description: true, date: true, _count: { select: { images: true } } },
  })
  const albumById = new Map(albums.map((a) => [a.id, a]))
  const wantedAlbum = album?.trim().toLowerCase()
  const albumIds = wantedAlbum ? albums.filter((a) => a.slug === wantedAlbum || a.title.toLowerCase().includes(wantedAlbum)).map((a) => a.id) : null

  const images = await prisma.galleryImage.findMany({
    where: albumIds ? { albumId: { in: albumIds } } : {},
    orderBy: [{ order: "asc" }],
    select: { publicId: true, alt: true, width: true, height: true, albumId: true, creditName: true },
  })
  const albumRank = new Map(albums.map((a, i) => [a.id, i]))
  const matches = images
    .map((image) => {
      const owner = image.albumId ? albumById.get(image.albumId) : undefined
      const haystack = `${owner?.title ?? ""} ${owner?.description ?? ""} ${image.alt ?? ""}`.toLowerCase()
      const score = words.length ? words.filter((word) => haystack.includes(word)).length : 1
      return { image, owner, score }
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || (albumRank.get(a.image.albumId ?? "") ?? 1e6) - (albumRank.get(b.image.albumId ?? "") ?? 1e6))
    .slice(0, Math.min(limit, 60))

  return {
    assets: matches.map(({ image, owner }) => ({
      url: galleryPhotoUrl(image.publicId),
      about: [image.alt, owner ? `album "${owner.title}"` : "no album", image.creditName ? `photo: ${image.creditName}` : null].filter(Boolean).join("; "),
      width: image.width ?? 0,
      height: image.height ?? 0,
      group: "gallery" as const,
      album: owner?.title ?? null,
    })),
    albums: albums
      .filter((a) => a._count.images > 0)
      .map((a) => ({ title: a.title, slug: a.slug, photos: a._count.images, date: a.date ? a.date.toISOString().slice(0, 10) : null })),
  }
}

export function orientation(width: number, height: number): "landscape" | "portrait" | "square" | "unknown" {
  if (!width || !height) return "unknown"
  const ratio = width / height
  return ratio > 1.15 ? "landscape" : ratio < 0.87 ? "portrait" : "square"
}
