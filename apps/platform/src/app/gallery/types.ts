export type GalleryPhoto = {
  id: string
  publicId: string
  alt: string
  width: number
  height: number
  creditName: string | null
  creditUrl: string | null
  albumSlug: string
  albumTitle: string
}

export type GalleryAlbumSummary = {
  slug: string
  title: string
  /** Display date, e.g. "Sep 2026" */
  dateLabel: string | null
  description: string | null
  eventHref: string | null
  photos: GalleryPhoto[]
}
