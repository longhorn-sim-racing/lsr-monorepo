import Link from "next/link"
import Image from "next/image"
import SectionReveal from "./SectionReveal"
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel"
import { galleryItems as staticGalleryItems, GalleryItem } from "@/lib/gallery"
import { GalleryImage } from "@prisma/client"
import { Camera } from "lucide-react"
import { cloudinaryUrl } from "@/lib/cloudinary"

export default function GalleryRibbon({ index, galleryImages }: { index: number, galleryImages: GalleryImage[] }) {
  // Cropped to the 16:9 tiles by Cloudinary, so these skip Next's optimizer (unoptimized below)
  const dbItems: GalleryItem[] = galleryImages.map(img => ({
    type: "image",
    src: cloudinaryUrl(img.publicId, { width: 960, height: 540, crop: "fill" }),
    alt: img.alt ?? "Gallery Image",
    credit: img.creditName ? {
      name: img.creditName,
      url: img.creditUrl ?? undefined
    } : undefined
  }));

  const items = [...dbItems, ...staticGalleryItems];

  return (
    <SectionReveal index={index} className="mx-auto max-w-6xl mt-10 md:mt-14" clipClass="rounded-none">
      <div className="bg-lsr-charcoal border border-white/5 p-6 md:p-10">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 mb-10">
          <div>
            <h2 className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal">
              The <span className="text-lsr-orange">Gallery</span>
            </h2>
            <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-2">Moments from the track</p>
          </div>
          <Link href="/gallery" className="group flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-white/60 hover:text-lsr-orange transition-colors" aria-label="See more in the gallery">
            View All
            <div className="h-px w-8 bg-white/20 group-hover:bg-lsr-orange group-hover:w-12 transition-all" />
          </Link>
        </div>

        <Carousel
          opts={{
            align: "start",
            loop: true,
          }}
          className="w-full group/carousel"
        >
          <CarouselContent className="-ml-4">
            {items.map((item, index) => (
              <CarouselItem key={index} className="pl-4 md:basis-1/2 lg:basis-1/3">
                <div className="aspect-video border border-white/10 bg-black overflow-hidden relative group">
                  {item.type === "image" ? (
                    <>
                      <Image
                        src={item.src}
                        alt={item.alt}
                        width={960}
                        height={540}
                        unoptimized
                        className="object-cover w-full h-full opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-700"
                      />
                      {item.credit && (
                        <div className="absolute bottom-0 left-0 flex items-center gap-2 px-3 py-1.5 bg-black/80 backdrop-blur-sm border-r border-t border-white/10">
                          <Camera className="w-3 h-3 text-lsr-orange" />
                          {item.credit.url ? (
                            <a 
                              href={item.credit.url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="font-sans font-bold text-[9px] uppercase tracking-widest text-white/70 hover:text-white transition-colors"
                            >
                              {item.credit.name}
                            </a>
                          ) : (
                            <span className="font-sans font-bold text-[9px] uppercase tracking-widest text-white/70">
                              {item.credit.name}
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <iframe
                      width="100%"
                      height="100%"
                      src={item.src}
                      title={item.title}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                      className="opacity-80 group-hover:opacity-100 transition-opacity"
                    ></iframe>
                  )}
                  {/* Decorative corner */}
                  <div className="absolute top-0 right-0 w-8 h-8 pointer-events-none">
                    <div className="absolute top-2 right-2 w-full h-full border-t border-r border-white/20" />
                  </div>
                </div>
              </CarouselItem>
            ))}
          </CarouselContent>
          <div className="flex justify-end gap-2 mt-8">
            <CarouselPrevious className="static translate-y-0 h-10 w-10 rounded-none bg-white/5 border-white/10 hover:bg-lsr-orange hover:border-lsr-orange hover:text-white transition-all" />
            <CarouselNext className="static translate-y-0 h-10 w-10 rounded-none bg-white/5 border-white/10 hover:bg-lsr-orange hover:border-lsr-orange hover:text-white transition-all" />
          </div>
        </Carousel>
      </div>
    </SectionReveal>
  )
}
