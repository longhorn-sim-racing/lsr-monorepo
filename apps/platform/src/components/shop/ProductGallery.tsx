"use client";

import Image from "next/image";
import { useState, useEffect, useCallback } from "react";
import { Image as ImageType } from "@/lib/shopify/types";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, X, ZoomIn } from "lucide-react";

export function ProductGallery({ images }: { images: ImageType[] }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);

  const goToPrevious = useCallback(() => {
    setSelectedIndex((i) => (i > 0 ? i - 1 : images.length - 1));
  }, [images.length]);

  const goToNext = useCallback(() => {
    setSelectedIndex((i) => (i < images.length - 1 ? i + 1 : 0));
  }, [images.length]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Leave arrow keys alone while someone is typing or using a menu
      const target = e.target as HTMLElement | null;
      if (e.defaultPrevented || target?.closest("input, textarea, select, [contenteditable], [role=listbox], [role=menu]")) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPrevious();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToNext();
      } else if (e.key === "Escape" && isZoomed) {
        setIsZoomed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goToPrevious, goToNext, isZoomed]);

  if (!images.length) return null;

  return (
    <>
      <div className="flex flex-col gap-4">
        {/* Main image: the zoom button covers it, with the arrows as siblings (buttons can't nest) */}
        <div className="group relative aspect-square w-full overflow-hidden border border-white/10 bg-white/[0.04]">
          <button
            type="button"
            onClick={() => setIsZoomed(true)}
            aria-label="Zoom in on this image"
            className="absolute inset-0 cursor-zoom-in"
          >
            <Image
              src={images[selectedIndex].url}
              alt={images[selectedIndex].altText || "Product image"}
              fill
              sizes="(min-width: 1024px) 50vw, 100vw"
              className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
              priority
            />
            <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/15">
              <ZoomIn className="h-8 w-8 text-white opacity-0 drop-shadow transition-opacity group-hover:opacity-100" aria-hidden />
            </span>
          </button>

          {images.length > 1 && (
            <>
              <button
                type="button"
                onClick={goToPrevious}
                className="absolute left-3 top-1/2 -translate-y-1/2 bg-lsr-charcoal/70 p-2.5 text-white backdrop-blur-sm transition-opacity hover:bg-lsr-charcoal md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                aria-label="Previous image"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={goToNext}
                className="absolute right-3 top-1/2 -translate-y-1/2 bg-lsr-charcoal/70 p-2.5 text-white backdrop-blur-sm transition-opacity hover:bg-lsr-charcoal md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                aria-label="Next image"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
              <span className="pointer-events-none absolute bottom-3 left-3 bg-lsr-charcoal/80 px-2.5 py-1 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/80">
                {selectedIndex + 1} / {images.length}
              </span>
            </>
          )}
        </div>

        {/* Thumbnails */}
        {images.length > 1 && (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {images.map((image, i) => (
              <button
                key={image.url}
                type="button"
                onClick={() => setSelectedIndex(i)}
                aria-label={`Show image ${i + 1}`}
                aria-current={i === selectedIndex}
                className={cn(
                  "relative h-20 w-20 flex-shrink-0 overflow-hidden border-2 bg-white/[0.04] transition-all",
                  i === selectedIndex
                    ? "border-lsr-orange opacity-100"
                    : "border-white/10 opacity-60 hover:opacity-100"
                )}
              >
                <Image
                  src={image.url}
                  alt={image.altText || "Product thumbnail"}
                  fill
                  sizes="80px"
                  className="object-cover"
                />
              </button>
            ))}
          </div>
        )}

      </div>

      {/* Zoom modal */}
      <Dialog open={isZoomed} onOpenChange={setIsZoomed}>
        <DialogContent className="max-w-5xl w-[95vw] h-[90vh] p-0 bg-black/95 border-white/10 rounded-none overflow-hidden" aria-describedby={undefined} showCloseButton={false}>
          <DialogTitle className="sr-only">Product images</DialogTitle>
          <div className="relative w-full h-full flex items-center justify-center">
            {/* Close button */}
            <button
              onClick={() => setIsZoomed(false)}
              className="absolute top-4 right-4 z-10 p-2 bg-white/10 text-white hover:bg-white/20 transition-colors"
              aria-label="Close zoom"
            >
              <X className="h-5 w-5" />
            </button>

            {/* Image counter */}
            {images.length > 1 && (
              <div className="absolute top-4 left-4 z-10 text-white/60 text-sm font-bold">
                {selectedIndex + 1} / {images.length}
              </div>
            )}

            {/* Main zoomed image */}
            <div className="relative w-full h-full">
              <Image
                src={images[selectedIndex].url}
                alt={images[selectedIndex].altText || "Product image"}
                fill
                sizes="95vw"
                className="object-contain"
                priority
              />
            </div>

            {/* Navigation arrows */}
            {images.length > 1 && (
              <>
                <button
                  onClick={goToPrevious}
                  className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-white/10 text-white hover:bg-white/20 transition-colors"
                  aria-label="Previous image"
                >
                  <ChevronLeft className="h-6 w-6" />
                </button>
                <button
                  onClick={goToNext}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-white/10 text-white hover:bg-white/20 transition-colors"
                  aria-label="Next image"
                >
                  <ChevronRight className="h-6 w-6" />
                </button>
              </>
            )}

            {/* Thumbnail strip at bottom */}
            {images.length > 1 && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 bg-black/50 p-2 backdrop-blur-sm">
                {images.map((image, i) => (
                  <button
                    key={image.url}
                    onClick={() => setSelectedIndex(i)}
                    className={cn(
                      "relative h-12 w-12 flex-shrink-0 overflow-hidden border transition-all",
                      i === selectedIndex
                        ? "border-lsr-orange opacity-100"
                        : "border-transparent opacity-50 hover:opacity-100"
                    )}
                  >
                    <Image
                      src={image.url}
                      alt={image.altText || "Product thumbnail"}
                      fill
                      sizes="48px"
                      className="object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
