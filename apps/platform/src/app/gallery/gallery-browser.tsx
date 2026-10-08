"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowRight, ArrowUpRight } from "lucide-react"
import { CloudinaryImage } from "@/components/cloudinary-image"
import { Lightbox } from "./lightbox"
import type { GalleryAlbumSummary, GalleryPhoto } from "./types"

// In the all-albums view each album shows this many photos before "See all".
const PREVIEW_COUNT = 8

export function GalleryBrowser({ albums, initialAlbum }: { albums: GalleryAlbumSummary[]; initialAlbum: string | null }) {
  const [active, setActive] = useState<string | null>(
    initialAlbum && albums.some((album) => album.slug === initialAlbum) ? initialAlbum : null
  )
  const [viewer, setViewer] = useState<{ photos: GalleryPhoto[]; index: number } | null>(null)

  const selectAlbum = (slug: string | null) => {
    setActive(slug)
    const url = new URL(window.location.href)
    if (slug) url.searchParams.set("album", slug)
    else url.searchParams.delete("album")
    window.history.replaceState(null, "", url)
    document.getElementById("albums")?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const shown = active ? albums.filter((album) => album.slug === active) : albums

  return (
    <>
      {/* Album filter */}
      {albums.length > 1 && (
        <div id="albums" className="scroll-mt-24 -mx-6 md:mx-0 mb-10 md:mb-14">
          <div className="flex gap-2 overflow-x-auto px-6 md:px-0 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-wrap md:gap-1.5">
            <Chip label="All albums" count={albums.reduce((n, a) => n + a.photos.length, 0)} active={!active} onClick={() => selectAlbum(null)} />
            {albums.map((album) => (
              <Chip
                key={album.slug}
                label={album.title}
                count={album.photos.length}
                active={active === album.slug}
                onClick={() => selectAlbum(album.slug)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-16 md:space-y-24">
        {shown.map((album) => {
          const preview = active ? album.photos : album.photos.slice(0, PREVIEW_COUNT)
          return (
            <section key={album.slug} aria-labelledby={`album-${album.slug}`}>
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 mb-6 md:mb-8 border-b border-white/10 pb-5">
                <div>
                  <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-2">
                    {[album.dateLabel, `${album.photos.length} ${album.photos.length === 1 ? "photo" : "photos"}`].filter(Boolean).join(" · ")}
                  </p>
                  <h2 id={`album-${album.slug}`} className="font-display font-black italic text-3xl md:text-4xl text-white uppercase tracking-normal leading-[0.95]">
                    {album.title}
                  </h2>
                  {album.description && <p className="mt-3 font-sans text-sm md:text-base text-white/55 max-w-2xl leading-relaxed">{album.description}</p>}
                </div>
                {album.eventHref && (
                  <Link
                    href={album.eventHref}
                    className="inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/60 hover:text-lsr-orange transition-colors shrink-0"
                  >
                    Event page
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>

              <div className="columns-2 md:columns-3 lg:columns-4 gap-2 md:gap-3">
                {preview.map((photo, i) => (
                  <button
                    key={photo.id}
                    type="button"
                    onClick={() => setViewer({ photos: album.photos, index: i })}
                    className="group relative mb-2 md:mb-3 block w-full break-inside-avoid overflow-hidden border border-white/5 bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-lsr-orange"
                    aria-label={`Open photo ${i + 1} of ${album.photos.length} from ${album.title}`}
                  >
                    <CloudinaryImage
                      publicId={photo.publicId}
                      alt={photo.alt}
                      width={photo.width}
                      height={photo.height}
                      sizes="(min-width: 1024px) 280px, (min-width: 768px) 33vw, 50vw"
                      className="h-auto w-full transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                    <div className="pointer-events-none absolute bottom-0 left-0 h-0.5 w-0 bg-lsr-orange transition-all duration-300 group-hover:w-full" />
                  </button>
                ))}
              </div>

              {!active && album.photos.length > PREVIEW_COUNT && (
                <button
                  type="button"
                  onClick={() => selectAlbum(album.slug)}
                  className="mt-6 inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white transition-colors"
                >
                  See all {album.photos.length} photos
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              )}
            </section>
          )
        })}
      </div>

      <Lightbox
        photos={viewer?.photos ?? []}
        index={viewer?.index ?? null}
        onIndexChange={(index) => setViewer((v) => (v ? { ...v, index } : v))}
        onClose={() => setViewer(null)}
      />
    </>
  )
}

function Chip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 inline-flex items-center gap-2 border px-3 h-9 font-sans font-bold text-[10px] uppercase tracking-[0.12em] transition-colors ${
        active ? "border-lsr-orange bg-lsr-orange text-white" : "border-white/15 text-white/70 hover:border-white/40 hover:text-white"
      }`}
    >
      {label}
      <span className={active ? "text-white/70" : "text-white/30"}>{count}</span>
    </button>
  )
}
