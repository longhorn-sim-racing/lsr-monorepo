"use client"

import { useState } from "react"
import Image from "next/image"
import { Play } from "lucide-react"

/**
 * A YouTube video that loads only when someone presses play: a thumbnail until then, so the page
 * doesn't pull in YouTube's player on every visit (or loop a video nobody can pause).
 */
export function HotlapVideo({ videoId, title }: { videoId: string; title: string }) {
  const [playing, setPlaying] = useState(false)
  // The 16:9 thumbnail, falling back to the 4:3 one (letterboxed) for videos without an HD frame
  const [thumb, setThumb] = useState("hq720")

  if (playing) {
    return (
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&rel=0`}
        title={title}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        className="absolute inset-0 h-full w-full"
      />
    )
  }

  return (
    <button type="button" onClick={() => setPlaying(true)} aria-label={`Play ${title}`} className="group absolute inset-0 h-full w-full">
      <Image
        src={`https://i.ytimg.com/vi/${videoId}/${thumb}.jpg`}
        alt=""
        fill
        unoptimized
        onError={() => setThumb("hqdefault")}
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
