import Image from "next/image"
import { Separator } from "@/components/ui/separator"
import { galleryItems } from "@/lib/gallery";
import { getAllGalleryImages } from "@/server/queries/gallery";
import { Camera } from "lucide-react";
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Gallery",
  description: "Experience the intensity of Longhorn Sim Racing through our photo archive and race reels.",
  alternates: {
    canonical: "/gallery",
  },
};

export default async function GalleryPage() {
  const videos = galleryItems.filter(item => item.type !== 'image');
  let images: Awaited<ReturnType<typeof getAllGalleryImages>>;
  try {
    images = await getAllGalleryImages();
  } catch {
    images = [];
  }
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME!;

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <div className="mx-auto max-w-6xl px-6 md:px-8 py-14 md:py-20">
        <div className="mb-10">
          <h1 className="font-display font-black italic text-5xl md:text-6xl text-white uppercase tracking-normal">
            The <span className="text-lsr-orange">Gallery</span>
          </h1>
          <p className="font-sans font-bold text-white/40 uppercase tracking-[0.3em] text-[10px] mt-2">Captured Moments from the Track</p>
        </div>

        <Separator className="my-10 bg-white/10" />

        <div className="mt-10">
          <div className="flex items-end justify-between mb-6 border-b border-white/10 pb-4">
            <h2 className="font-display font-black italic text-2xl md:text-3xl text-white uppercase tracking-normal">Feature <span className="text-lsr-orange">Reels</span></h2>
          </div>
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
            {videos.map((video, index) => (
              <div key={index} className="aspect-video border border-white/10 bg-black relative group">
                <iframe
                  width="100%"
                  height="100%"
                  src={video.src}
                  title={video.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                  className="w-full h-full opacity-80 group-hover:opacity-100 transition-opacity duration-500"
                ></iframe>
                {/* Corner accent */}
                <div className="absolute top-0 right-0 w-8 h-8 pointer-events-none">
                  <div className="absolute top-0 right-0 w-full h-full border-t-2 border-r-2 border-lsr-orange opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-16">
          <div className="flex items-end justify-between mb-6 border-b border-white/10 pb-4">
            <h2 className="font-display font-black italic text-2xl md:text-3xl text-white uppercase tracking-normal">Photo <span className="text-lsr-orange">Archive</span></h2>
          </div>
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
            {images.map((image) => (
              <div key={image.id} className="aspect-[4/3] border border-white/10 bg-black relative group overflow-hidden">
                <Image
                  src={`https://res.cloudinary.com/${cloudName}/image/upload/v1/${image.publicId}`}
                  alt={image.alt ?? image.creditName ?? 'Longhorn Sim Racing photo'}
                  width={800}
                  height={600}
                  className="object-cover w-full h-full opacity-85 group-hover:opacity-100 group-hover:scale-105 transition-all duration-700"
                />
                
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent opacity-60 group-hover:opacity-100 transition-opacity duration-300" />
                
                {image.creditName && (
                  <div className="absolute bottom-0 left-0 w-full p-4 z-10">
                    <div className="flex items-center gap-2 animate-in fade-in slide-in-from-left-4 duration-1000">
                      <Camera className="w-3 h-3 text-lsr-orange shadow-sm" />
                      {image.creditUrl ? (
                        <a 
                          href={image.creditUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="font-sans font-bold text-[9px] uppercase tracking-widest text-white/90 hover:text-lsr-orange transition-colors"
                        >
                          {image.creditName}
                        </a>
                      ) : (
                        <span className="font-sans font-bold text-[9px] uppercase tracking-widest text-white/90">{image.creditName}</span>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Corner accent */}
                <div className="absolute bottom-0 right-0 w-6 h-6 pointer-events-none">
                  <div className="absolute bottom-0 right-0 w-full h-full border-b-2 border-r-2 border-lsr-orange opacity-0 group-hover:opacity-100 transition-opacity delay-100" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}
