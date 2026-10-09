import Image from "next/image"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import type { getAllPosts } from "@/lib/news"
import { DEFAULT_TIMEZONE } from "@/lib/dates"

export type PostSummary = Awaited<ReturnType<typeof getAllPosts>>[number]

export function formatPostDate(iso: string, month: "long" | "short" = "long") {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month, day: "numeric", timeZone: DEFAULT_TIMEZONE })
}

/** The post's cover photo, or a date plate when it has none. */
function Cover({ post, sizes, preload }: { post: PostSummary; sizes: string; preload?: boolean }) {
  if (post.coverImageUrl) {
    return (
      <Image
        src={post.coverImageUrl}
        alt=""
        fill
        sizes={sizes}
        preload={preload}
        className="object-cover transition-transform duration-500 group-hover:scale-105"
      />
    )
  }
  const date = new Date(post.date)
  const day = date.toLocaleDateString("en-US", { day: "numeric", timeZone: DEFAULT_TIMEZONE })
  const month = date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: DEFAULT_TIMEZONE })
  return (
    <div className="absolute inset-0 bg-gradient-to-br from-white/[0.07] via-white/[0.02] to-transparent">
      <div className="absolute inset-0 opacity-[0.04] [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_12px)]" />
      <div className="absolute -bottom-20 -right-16 h-56 w-56 rounded-full bg-lsr-orange/10 blur-3xl" />
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display font-black italic text-7xl md:text-8xl leading-none text-white/15 transition-colors duration-300 group-hover:text-lsr-orange/70">
          {day}
        </span>
        <span className="mt-2 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/35">{month}</span>
      </div>
    </div>
  )
}

function Tags({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null
  return (
    <div className="flex flex-wrap gap-2">
      {tags.map((tag) => (
        <span key={tag} className="bg-lsr-orange/10 px-2 py-0.5 font-sans font-black text-[9px] uppercase tracking-widest text-lsr-orange">
          {tag}
        </span>
      ))}
    </div>
  )
}

/** The newest post, full width. */
export function FeaturedPost({ post }: { post: PostSummary }) {
  return (
    <Link
      href={`/news/${post.slug}`}
      className="group relative grid overflow-hidden border border-white/10 bg-white/[0.02] transition-colors hover:border-lsr-orange/50 md:grid-cols-[3fr_2fr]"
    >
      <div className="absolute top-0 left-0 z-10 h-1 w-24 bg-lsr-orange transition-all duration-300 group-hover:w-full" />
      <div className="relative aspect-video md:aspect-auto md:min-h-[360px] overflow-hidden border-b md:border-b-0 md:border-r border-white/10">
        <Cover post={post} sizes="(min-width: 768px) 60vw, 100vw" preload />
      </div>
      <div className="flex flex-col justify-center p-6 md:p-10">
        <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Latest · {formatPostDate(post.date)}</p>
        <h2 className="mt-4 font-display font-black italic text-3xl md:text-5xl text-white uppercase tracking-normal leading-[0.95] group-hover:text-lsr-orange transition-colors">
          {post.title}
        </h2>
        {post.excerpt && <p className="mt-4 font-sans text-sm md:text-base text-white/60 leading-relaxed line-clamp-4">{post.excerpt}</p>}
        <div className="mt-5">
          <Tags tags={post.tags} />
        </div>
        <div className="mt-8 flex items-center justify-between gap-4 border-t border-white/10 pt-5">
          <span className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/40">By {post.author}</span>
          <span className="inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white group-hover:text-lsr-orange transition-colors">
            Read
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
          </span>
        </div>
      </div>
    </Link>
  )
}

export function PostCard({ post }: { post: PostSummary }) {
  return (
    <Link
      href={`/news/${post.slug}`}
      className="group flex flex-col overflow-hidden border border-white/10 bg-white/[0.02] transition-colors hover:border-lsr-orange/50"
    >
      {/* A date plate doesn't need a full 16:9 on phones */}
      <div className={`relative overflow-hidden border-b border-white/10 ${post.coverImageUrl ? "aspect-video" : "aspect-[5/2] sm:aspect-video"}`}>
        <Cover post={post} sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" />
      </div>
      <div className="flex flex-1 flex-col p-6">
        <time dateTime={post.date} className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">
          {formatPostDate(post.date, "short")}
        </time>
        <h3 className="mt-3 font-display font-black italic text-2xl text-white uppercase tracking-normal leading-tight group-hover:text-lsr-orange transition-colors">
          {post.title}
        </h3>
        {post.excerpt && <p className="mt-3 font-sans text-sm text-white/55 leading-relaxed line-clamp-3">{post.excerpt}</p>}
        <div className="mt-auto pt-5">
          <Tags tags={post.tags} />
        </div>
      </div>
    </Link>
  )
}
