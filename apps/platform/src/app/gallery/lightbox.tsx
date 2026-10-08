"use client"

import { useEffect, useRef } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Camera, ChevronLeft, ChevronRight, X } from "lucide-react"
import { CloudinaryImage } from "@/components/cloudinary-image"
import { cloudinaryUrl } from "@/lib/cloudinary"
import type { GalleryPhoto } from "./types"

const SWIPE_PX = 50

export function Lightbox({
  photos,
  index,
  onIndexChange,
  onClose,
}: {
  photos: GalleryPhoto[]
  index: number | null
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const photo = index === null ? null : photos[index]
  const touchStartX = useRef<number | null>(null)

  const go = (delta: number) => {
    if (index === null || photos.length < 2) return
    onIndexChange((index + delta + photos.length) % photos.length)
  }

  // Warm the cache for the neighbours so arrowing through feels instant.
  useEffect(() => {
    if (index === null || photos.length < 2) return
    for (const d of [1, -1]) {
      const next = photos[(index + d + photos.length) % photos.length]
      const img = new window.Image()
      img.src = cloudinaryUrl(next.publicId, { width: 1920 })
    }
  }, [index, photos])

  return (
    <DialogPrimitive.Root open={photo !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/95 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col outline-none"
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") go(1)
            if (e.key === "ArrowLeft") go(-1)
          }}
          aria-describedby={undefined}
        >
          {photo && (
            <>
              <DialogPrimitive.Title className="sr-only">
                {photo.albumTitle}: photo {index! + 1} of {photos.length}
              </DialogPrimitive.Title>

              {/* Top bar */}
              <div className="flex items-center justify-between gap-4 px-4 md:px-6 h-14 shrink-0">
                <div className="min-w-0">
                  <p className="font-display font-black italic text-sm md:text-base uppercase text-white truncate">{photo.albumTitle}</p>
                  <p className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/40">
                    {index! + 1} / {photos.length}
                  </p>
                </div>
                <DialogPrimitive.Close
                  className="flex h-10 w-10 items-center justify-center border border-white/15 text-white/70 hover:text-white hover:border-white/40 transition-colors"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </DialogPrimitive.Close>
              </div>

              {/* Photo */}
              <div
                className="relative flex-1 min-h-0 mx-2 md:mx-16 select-none touch-pan-y"
                onTouchStart={(e) => (touchStartX.current = e.touches[0].clientX)}
                onTouchEnd={(e) => {
                  if (touchStartX.current === null) return
                  const dx = e.changedTouches[0].clientX - touchStartX.current
                  touchStartX.current = null
                  if (Math.abs(dx) > SWIPE_PX) go(dx < 0 ? 1 : -1)
                }}
              >
                <CloudinaryImage
                  key={photo.id}
                  publicId={photo.publicId}
                  alt={photo.alt}
                  fill
                  sizes="100vw"
                  className="object-contain animate-in fade-in-0 duration-300"
                  priority
                />
              </div>

              {/* Bottom bar */}
              <div className="flex items-center justify-between gap-4 px-4 md:px-6 h-16 shrink-0">
                <div className="min-w-0 font-sans text-xs text-white/50">
                  {photo.creditName && (
                    <span className="inline-flex items-center gap-2">
                      <Camera className="h-3.5 w-3.5 text-lsr-orange" />
                      {photo.creditUrl ? (
                        <a href={photo.creditUrl} target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">
                          {photo.creditName}
                        </a>
                      ) : (
                        photo.creditName
                      )}
                    </span>
                  )}
                </div>
                {photos.length > 1 && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => go(-1)}
                      className="flex h-11 w-11 items-center justify-center border border-white/15 text-white/70 hover:text-white hover:border-lsr-orange transition-colors"
                      aria-label="Previous photo"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => go(1)}
                      className="flex h-11 w-11 items-center justify-center border border-white/15 text-white/70 hover:text-white hover:border-lsr-orange transition-colors"
                      aria-label="Next photo"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
