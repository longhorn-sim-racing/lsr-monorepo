"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowUpRight } from "lucide-react"

// The subset of Twitch's interactive embed (player.twitch.tv/js/embed/v1.js) used here
type TwitchPlayer = { addEventListener: (event: string, callback: () => void) => void }
type TwitchApi = {
  Player: (new (element: HTMLElement, options: Record<string, unknown>) => TwitchPlayer) & {
    ONLINE: string
    OFFLINE: string
    PLAYING: string
  }
}

const SCRIPT_SRC = "https://player.twitch.tv/js/embed/v1.js"

/**
 * The channel's Twitch player, revealed only once the channel is actually live. Until then it
 * stays invisible, so an offline channel never shows Twitch's "offline" card. Starts muted.
 */
export function LiveStream({ channel }: { channel: string }) {
  const mount = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    const element = mount.current
    if (!element) return
    let cancelled = false

    const start = () => {
      const Twitch = (window as unknown as { Twitch?: TwitchApi }).Twitch
      if (cancelled || !Twitch?.Player) return
      element.replaceChildren()
      const player = new Twitch.Player(element, {
        channel,
        parent: [window.location.hostname],
        width: "100%",
        height: "100%",
        autoplay: true,
        muted: true,
      })
      player.addEventListener(Twitch.Player.ONLINE, () => setLive(true))
      player.addEventListener(Twitch.Player.PLAYING, () => setLive(true))
      player.addEventListener(Twitch.Player.OFFLINE, () => setLive(false))
    }

    let script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`)
    if ((window as unknown as { Twitch?: TwitchApi }).Twitch?.Player) {
      start()
    } else {
      if (!script) {
        script = document.createElement("script")
        script.src = SCRIPT_SRC
        script.async = true
        document.body.appendChild(script)
      }
      script.addEventListener("load", start)
    }

    return () => {
      cancelled = true
      script?.removeEventListener("load", start)
      element.replaceChildren()
    }
  }, [channel])

  return (
    <div
      // Offline it stays mounted (Twitch needs the element to report the channel going live) but takes
      // no room on narrow screens, where it would otherwise leave a gap under the hero text
      className={`transition-opacity duration-700 ${live ? "opacity-100 max-lg:mt-10" : "pointer-events-none opacity-0 max-lg:h-0 max-lg:overflow-hidden"}`}
      aria-hidden={!live}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 bg-red-600 px-2.5 py-1 font-sans font-black text-[10px] uppercase tracking-[0.2em] text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
          Live now
        </span>
        <a
          href={`https://www.twitch.tv/${channel}`}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={live ? undefined : -1}
          className="inline-flex items-center gap-1 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-lsr-orange transition-colors"
        >
          Open on Twitch <ArrowUpRight className="h-3 w-3" />
        </a>
      </div>
      <div ref={mount} className="aspect-video w-full overflow-hidden border border-white/15 bg-black shadow-2xl" />
      <p className="mt-2 font-sans text-[11px] text-white/45">Starts muted. Use the player&apos;s volume to turn it up.</p>
    </div>
  )
}
