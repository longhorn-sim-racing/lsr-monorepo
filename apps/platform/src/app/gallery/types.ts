export type GalleryPhoto = {
  id: string
  publicId: string
  alt: string
  width: number
  height: number
  /** False for older rows without a stored size (width/height are a 3:2 guess) */
  sized: boolean
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
