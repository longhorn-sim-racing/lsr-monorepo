"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { X, Tv, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DEFAULT_TIMEZONE, zoneLabel } from "@/lib/dates"

type Props = {
  event: {
    title: string
    slug: string
    streamUrl: string | null
    startsAtUtc: Date
    endsAtUtc: Date
    timezone: string | null
  }
}

export function LiveBannerClient({ event }: Props) {
  const [isVisible, setIsVisible] = useState(true)
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
    const dismissed = sessionStorage.getItem(`live-banner-dismissed-${event.slug}`)
    if (dismissed) {
      setIsVisible(false)
    }
  }, [event.slug])

  const formatTime = (date: Date) => {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: event.timezone || DEFAULT_TIMEZONE
    }).format(new Date(date)).toLowerCase()
  }

  const handleDismiss = () => {
    setIsVisible(false)
    sessionStorage.setItem(`live-banner-dismissed-${event.slug}`, "true")
  }

  if (!isMounted || !isVisible) return null

  return (
    <div className="relative bg-lsr-charcoal border-b border-white/5 shadow-lg overflow-hidden group">
        {/* Animated Borders */}
        <div className="absolute top-0 h-[2px] bg-lsr-orange z-20 animate-[lsr-border-top_4s_linear_infinite] pointer-events-none" />
        <div className="absolute top-0 right-0 w-[2px] bg-lsr-orange z-20 animate-[lsr-border-side_4s_linear_infinite] pointer-events-none" />
        <div className="absolute top-0 left-0 w-[2px] bg-lsr-orange z-20 animate-[lsr-border-side_4s_linear_infinite] pointer-events-none" />
        <div className="absolute bottom-0 left-0 h-[2px] bg-lsr-orange z-20 animate-[lsr-border-bottom_4s_linear_infinite] pointer-events-none" />
        <div className="absolute bottom-0 right-0 h-[2px] bg-lsr-orange z-20 animate-[lsr-border-bottom_4s_linear_infinite] pointer-events-none" />

        {/* The whole banner opens the event, through a link layered under the content rather than
            wrapped around it, so the Watch and Details links aren't nested inside another link */}
        <div className="block w-full relative z-10 hover:bg-white/[0.02] transition-colors">
            {/* A mouse shortcut only: keyboard and screen-reader users have the Details link */}
            <Link href={`/events/${event.slug}`} tabIndex={-1} aria-hidden="true" className="absolute inset-0" />
            <div className="pointer-events-none relative mx-auto max-w-6xl px-4 py-2 sm:px-6 min-h-[48px] flex items-center">
                
                {/* 
                  DESKTOP LAYOUT 
                  Exactly preserving the previous accepted design for md+ screens
                */}
                <div className="hidden md:flex items-center justify-between gap-3 w-full">
                    {/* Left side: Live indicator */}
                    <div className="flex items-center gap-3 shrink-0">
                        <span className="relative flex h-3 w-3">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-600"></span>
                        </span>
                        <span className="font-display font-black text-red-500 uppercase tracking-[0.2em] text-sm sm:text-base italic">Live Now</span>
                    </div>
                    
                    {/* Center: Time | Title */}
                    <div className="flex items-center gap-4 flex-1 justify-center text-center">
                        <div className="flex items-center font-sans font-bold text-[11px] uppercase tracking-wider text-white/40">
                            {formatTime(event.startsAtUtc)} - {formatTime(event.endsAtUtc)} {zoneLabel(new Date(event.startsAtUtc), event.timezone || DEFAULT_TIMEZONE)}
                        </div>
                        
                        <div className="w-px h-3 bg-white/10" />
                        
                        <span className="font-sans font-bold text-white text-sm tracking-wide line-clamp-1">
                            {event.title}
                        </span>
                    </div>

                    {/* Right side: Actions and Dismiss */}
                    <div className="pointer-events-auto flex items-center gap-4 shrink-0">
                        <div className="flex items-center gap-2">
                            {event.streamUrl && (
                                <Button asChild size="sm" variant="outline" className="h-7 text-[10px] px-3 border-white/20 text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-wider rounded-none transition-all">
                                    <Link href={event.streamUrl} target="_blank" rel="noopener noreferrer">
                                        <Tv className="mr-1.5 h-3 w-3" />
                                        Watch
                                    </Link>
                                </Button>
                            )}
                            
                            <Button asChild size="sm" variant="ghost" className="h-7 text-[10px] px-3 text-white/60 hover:text-white hover:bg-white/5 font-bold uppercase tracking-wider rounded-none transition-all">
                                <Link href={`/events/${event.slug}`}>
                                    Details
                                    <ArrowRight className="ml-1.5 h-3 w-3" />
                                </Link>
                            </Button>
                        </div>

                        <div className="w-px h-4 bg-white/10" />

                        <button 
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleDismiss();
                            }}
                            className="text-white/30 hover:text-white transition-colors p-1 relative z-30"
                            aria-label="Dismiss banner"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* 
                  MOBILE LAYOUT 
                  Compact 2-line design for smaller screens
                */}
                <div className="flex md:hidden flex-col gap-2 w-full py-0.5">
                    {/* Top Row: LIVE (Left) | Actions/Dismiss (Right) */}
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-1.5 shrink-0">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-600"></span>
                            </span>
                            <span className="font-display font-black text-red-500 uppercase tracking-widest text-[10px] italic">Live</span>
                        </div>

                        <div className="pointer-events-auto flex items-center gap-2 shrink-0">
                            {event.streamUrl && (
                                <Button asChild size="sm" variant="outline" className="h-6 text-[9px] px-2 border-white/20 text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-wider rounded-none transition-all">
                                    <Link href={event.streamUrl} target="_blank" rel="noopener noreferrer">
                                        <Tv className="mr-1 h-2.5 w-2.5" />
                                        Watch
                                    </Link>
                                </Button>
                            )}
                            
                            <Button asChild size="sm" variant="ghost" className="h-6 text-[9px] px-2 text-white/60 hover:text-white hover:bg-white/5 font-bold uppercase tracking-wider rounded-none transition-all">
                                <Link href={`/events/${event.slug}`} aria-label="Event details">
                                    <ArrowRight className="h-2.5 w-2.5" />
                                </Link>
                            </Button>

                            <button 
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleDismiss();
                                }}
                                className="text-white/30 hover:text-white transition-colors p-1 -mr-1 relative z-30"
                                aria-label="Dismiss banner"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>

                    {/* Bottom Row: Centered Time | Title */}
                    <div className="flex items-center justify-center gap-2 px-2 text-center overflow-hidden">
                        <div className="font-sans font-bold text-[9px] text-white/40 uppercase tracking-wider shrink-0">
                            {formatTime(event.startsAtUtc)} - {formatTime(event.endsAtUtc)} {zoneLabel(new Date(event.startsAtUtc), event.timezone || DEFAULT_TIMEZONE)}
                        </div>
                        
                        <div className="w-px h-2 bg-white/10 shrink-0" />
                        
                        <span className="font-sans font-bold text-white text-[10px] tracking-wide truncate">
                            {event.title}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    </div>
  )
}