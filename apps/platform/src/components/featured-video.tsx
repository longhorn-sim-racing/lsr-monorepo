"use client"

import { useState } from "react"
import Image from "next/image"
import { Play } from "lucide-react"
import type { VideoSource } from "@/lib/featured-video"

/** The button goes away when the video starts, so keyboard focus moves to the player */
function focusPlayer(player: HTMLElement | null) {
  player?.focus()
}

/**
 * The home page's featured video, from YouTube or an upload, that loads only when someone presses play:
 * a still frame until then, so the page doesn't pull in a player on every visit (or loop a video nobody
 * can pause).
 */
export function FeaturedVideo({ source, title }: { source: VideoSource; title: string }) {
  const [playing, setPlaying] = useState(false)
  // YouTube's 16:9 thumbnail, falling back to the 4:3 one (letterboxed) for videos without an HD frame
  const [thumb, setThumb] = useState("hq720")

  if (playing) {
    return source.kind === "youtube" ? (
      <iframe
        ref={focusPlayer}
        src={`https://www.youtube-nocookie.com/embed/${source.id}?autoplay=1&playsinline=1&rel=0`}
        title={title}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        className="absolute inset-0 h-full w-full"
      />
    ) : (
      <video
        ref={focusPlayer}
        src={source.src}
        poster={source.poster}
        aria-label={title}
        controls
        autoPlay
        playsInline
        className="absolute inset-0 h-full w-full"
      />
    )
  }

  return (
    <button type="button" onClick={() => setPlaying(true)} aria-label={`Play ${title}`} className="group absolute inset-0 h-full w-full">
      <Image
        src={source.kind === "youtube" ? `https://i.ytimg.com/vi/${source.id}/${thumb}.jpg` : source.poster}
        alt=""
        fill
        unoptimized
        // A missing YouTube HD frame comes back as a 120×90 placeholder rather than an error
        onLoad={(e) => source.kind === "youtube" && e.currentTarget.naturalWidth <= 120 && setThumb("hqdefault")}
        onError={() => source.kind === "youtube" && setThumb("hqdefault")}
        className="object-cover opacity-75 transition-opacity duration-500 group-hover:opacity-100"
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex h-16 w-16 items-center justify-center bg-lsr-orange text-white shadow-2xl transition-transform group-hover:scale-110 group-focus-visible:scale-110">
          <Play className="ml-1 h-7 w-7 fill-current" aria-hidden />
        </span>
      </span>
    </button>
  )
}
