import Image from "next/image"
import Link from "next/link"
import { Metadata } from "next"
import { formatInTimeZone } from "date-fns-tz"
import { Instagram } from "lucide-react"
import type { GalleryImage } from "@prisma/client"
import { CloudinaryImage } from "@/components/cloudinary-image"
import { galleryItems } from "@/lib/gallery"
import { isEventPublic } from "@/lib/events"
import { getGalleryAlbums, getUnsortedGalleryImages } from "@/server/queries/gallery"
import { GalleryBrowser } from "./gallery-browser"
import type { GalleryAlbumSummary, GalleryPhoto } from "./types"

export const metadata: Metadata = {
  title: "Gallery",
  description: "Race nights, track days and club events: photos and reels from Longhorn Sim Racing at UT Austin.",
  alternates: {
    canonical: "/gallery",
  },
};

const INSTAGRAM_URL = "https://instagram.com/longhorn_sim_racing"
// Old rows predate stored sizes; assume a landscape 3:2 photo until they're backfilled.
const FALLBACK_SIZE = { width: 1500, height: 1000 }

function toPhoto(image: GalleryImage, albumSlug: string, albumTitle: string): GalleryPhoto {
  return {
    id: image.id,
    publicId: image.publicId,
    alt: image.alt || `Longhorn Sim Racing: ${albumTitle}`,
    width: image.width ?? FALLBACK_SIZE.width,
    height: image.height ?? FALLBACK_SIZE.height,
    creditName: image.creditName,
    creditUrl: image.creditUrl,
    albumSlug,
    albumTitle,
  }
}

async function loadAlbums(): Promise<GalleryAlbumSummary[]> {
  try {
    const [albums, unsorted] = await Promise.all([getGalleryAlbums(), getUnsortedGalleryImages()])
    const summaries: GalleryAlbumSummary[] = albums.map((album) => ({
      slug: album.slug,
      title: album.title,
      dateLabel: album.date ? formatInTimeZone(album.date, "America/Chicago", "MMM yyyy") : null,
      description: album.description,
      eventHref: album.event && isEventPublic(album.event) ? `/events/${album.event.slug}` : null,
      photos: album.images.map((image) => toPhoto(image, album.slug, album.title)),
    }))
    if (unsorted.length > 0) {
      summaries.push({
        slug: "more",
        title: "More photos",
        dateLabel: null,
        description: null,
        eventHref: null,
        photos: unsorted.map((image) => toPhoto(image, "more", "More photos")),
      })
    }
    return summaries
  } catch (error) {
    console.error("[gallery] Failed to load albums:", error)
    return []
  }
}

export default async function GalleryPage({ searchParams }: { searchParams: Promise<{ album?: string }> }) {
  const [{ album: initialAlbum }, albums] = await Promise.all([searchParams, loadAlbums()])
  const photoCount = albums.reduce((n, album) => n + album.photos.length, 0)
  // Hero: the first landscape photo of the newest album.
  const cover = albums.flatMap((album) => album.photos).find((photo) => photo.width > photo.height)
  const videos = galleryItems.filter((item) => item.type !== "image")

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      {/* Hero */}
      <div className="relative border-b border-white/10 overflow-hidden">
        <div className="absolute inset-0 z-0">
          {cover ? (
            <CloudinaryImage
              publicId={cover.publicId}
              alt=""
              fill
              sizes="100vw"
              priority
              className="object-cover opacity-70"
            />
          ) : (
            <Image src="/images/lsr-hero2.webp" alt="" fill sizes="100vw" priority className="object-cover opacity-40" />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/60 via-lsr-charcoal/25 to-lsr-charcoal" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal/70 via-lsr-charcoal/20 to-transparent" />
        </div>
        <div className="absolute inset-0 opacity-[0.03] mix-blend-overlay [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />

        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 pt-24 pb-14 md:pt-36 md:pb-20">
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-4">Shot by LSR Media</p>
          <h1 className="font-display font-black italic text-5xl md:text-8xl text-white uppercase tracking-normal leading-[0.9]">
            The <span className="text-lsr-orange">Gallery</span>
          </h1>
          <p className="mt-6 max-w-2xl font-sans text-base md:text-xl font-bold text-white/80 leading-relaxed">
            Race nights, track days and everything in between.
          </p>
          {photoCount > 0 && (
            <p className="mt-6 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/50">
              {photoCount} photos · {albums.length} {albums.length === 1 ? "album" : "albums"}
            </p>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-12 md:py-20">
        {albums.length > 0 ? (
          <GalleryBrowser albums={albums} initialAlbum={initialAlbum ?? null} />
        ) : (
          <div className="border border-white/10 bg-white/[0.02] p-10 md:p-16 text-center">
            <h2 className="font-display font-black italic text-3xl md:text-4xl uppercase">
              Photos are <span className="text-lsr-orange">on the way</span>
            </h2>
            <p className="mt-4 font-sans text-white/55">In the meantime, our latest shots are on Instagram.</p>
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8 inline-flex items-center gap-2 border border-white/15 px-6 h-12 font-sans font-bold text-[10px] uppercase tracking-widest hover:bg-white hover:text-lsr-charcoal transition-colors"
            >
              <Instagram className="h-4 w-4" />
              @longhorn_sim_racing
            </a>
          </div>
        )}

        {/* Reels */}
        {videos.length > 0 && (
          <section className="mt-20 md:mt-28" aria-labelledby="reels">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 mb-6 md:mb-8 border-b border-white/10 pb-5">
              <div>
                <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-2">Watch</p>
                <h2 id="reels" className="font-display font-black italic text-3xl md:text-4xl uppercase leading-[0.95]">
                  Feature <span className="text-lsr-orange">reels</span>
                </h2>
              </div>
              <Link
                href={INSTAGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/60 hover:text-lsr-orange transition-colors"
              >
                <Instagram className="h-3.5 w-3.5" />
                More on Instagram
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
              {videos.map((video) => (
                <div key={video.src} className="aspect-video border border-white/10 bg-black">
                  <iframe
                    src={video.src}
                    title={video.title}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    loading="lazy"
                    className="h-full w-full"
                  />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  )
}
