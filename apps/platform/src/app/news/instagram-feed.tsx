import { ArrowUpRight, Film, Instagram, Layers } from "lucide-react"
import type { InstagramPost } from "@prisma/client"
import { CloudinaryImage } from "@/components/cloudinary-image"
import { INSTAGRAM_PROFILE_URL } from "@/lib/instagram"
import { DEFAULT_TIMEZONE } from "@/lib/dates"

/** The club's latest Instagram posts as square tiles, each linking to the post on Instagram. */
export function InstagramFeed({ posts }: { posts: InstagramPost[] }) {
  return (
    <section aria-labelledby="instagram-heading">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-10 md:mb-12">
        <div>
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange mb-3">@longhorn_sim_racing</p>
          <h2 id="instagram-heading" className="font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal leading-[0.95]">
            From <span className="text-lsr-orange">Instagram</span>
          </h2>
        </div>
        <a
          href={INSTAGRAM_PROFILE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex w-fit items-center gap-2 border border-white/15 px-4 h-10 font-sans font-bold text-[10px] uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal transition-colors"
        >
          <Instagram className="h-3.5 w-3.5" />
          Follow us
        </a>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3">
        {posts.map((post) => {
          const caption = post.caption?.trim()
          const date = post.postedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: DEFAULT_TIMEZONE })
          return (
            <a
              key={post.id}
              href={post.permalink}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Instagram post from ${date}${caption ? `: ${caption.slice(0, 80)}` : ""}`}
              className="group relative aspect-square overflow-hidden border border-white/10 bg-black/30"
            >
              <CloudinaryImage
                publicId={post.publicId!}
                alt=""
                fill
                sizes="(min-width: 1024px) 25vw, 50vw"
                className="object-cover transition-transform duration-500 group-hover:scale-105"
              />
              {post.mediaType === "VIDEO" && <Film className="absolute top-3 right-3 h-4 w-4 text-white drop-shadow-md" />}
              {post.mediaType === "CAROUSEL_ALBUM" && <Layers className="absolute top-3 right-3 h-4 w-4 text-white drop-shadow-md" />}
              <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-lsr-charcoal/95 via-lsr-charcoal/60 to-transparent p-4 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
                <p className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange">{date}</p>
                {caption && <p className="mt-1 font-sans text-xs text-white/85 leading-relaxed line-clamp-3">{caption}</p>}
                <span className="mt-2 inline-flex items-center gap-1 font-sans font-bold text-[9px] uppercase tracking-[0.2em] text-white">
                  View on Instagram <ArrowUpRight className="h-3 w-3" />
                </span>
              </div>
            </a>
          )
        })}
      </div>
    </section>
  )
}
