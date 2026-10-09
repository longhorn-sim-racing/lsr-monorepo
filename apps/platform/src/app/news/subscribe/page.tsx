"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Copy, Check, Rss } from "lucide-react"

export default function SubscribePage() {
  // Build absolute feed URL on the client, fallback to relative if SSR only
  const feedUrl = useMemo(() => {
    if (typeof window !== "undefined") {
      return `${window.location.origin}/news/rss.xml`
    }
    return "/news/rss.xml"
  }, [])

  const encoded = encodeURIComponent(feedUrl)
  const feedly = `https://feedly.com/i/subscription/feed/${encoded}`
  const inoreader = `https://www.inoreader.com/?add_feed=${encoded}`
  const newsblur = `https://www.newsblur.com/?url=${encoded}`

  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(feedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback: create a temp input if clipboard API is blocked
      const el = document.createElement("input")
      el.value = feedUrl
      document.body.appendChild(el)
      el.select()
      document.execCommand("copy")
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="min-h-screen bg-lsr-charcoal text-white pt-24 pb-20 px-6 md:px-8">
      <div className="mx-auto max-w-3xl">
      <header className="text-center mb-16">
        <div className="inline-flex items-center gap-2 rounded-full border border-lsr-orange/30 bg-lsr-orange/10 px-4 py-1.5 text-[10px] md:text-xs uppercase tracking-[0.2em] text-lsr-orange font-bold mb-6">
          <Rss className="h-3 w-3" />
          Subscribe
        </div>
        <h1 className="font-display font-black italic text-4xl md:text-6xl text-white uppercase tracking-normal leading-none">
          Follow <span className="text-lsr-orange">LSR</span>
        </h1>
        <p className="mt-6 text-white/50 font-sans text-lg max-w-xl mx-auto leading-relaxed">
          Add our RSS feed to your reader to get news, event updates, and results instantly.
        </p>
      </header>

      {/* Copy box */}
      <div className="rounded-none border border-white/5 bg-white/[0.03] p-4 md:p-6 flex flex-col md:flex-row items-center gap-4 relative overflow-hidden group">
        <div className="absolute top-0 left-0 w-1 h-full bg-lsr-orange opacity-50 group-hover:opacity-100 transition-opacity" />
        
        <code className="flex-1 font-mono text-sm text-white/80 bg-black/20 p-3 rounded-none border border-white/5 w-full md:w-auto overflow-x-auto">
          {feedUrl}
        </code>
        
        <Button
            size="sm"
            className="w-full md:w-auto rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-11 px-6 transition-all"
            onClick={copy}
            aria-label="Copy RSS feed URL"
            title="Copy RSS feed URL"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 mr-2" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3 mr-2" />
                Copy URL
              </>
            )}
        </Button>
      </div>

      {/* Reader quick-links */}
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <a
          href={feedly}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center justify-center gap-2 rounded-none border border-white/10 bg-white/5 px-4 py-4 text-xs font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal transition-all"
        >
          Feedly
        </a>
        <a
          href={inoreader}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center justify-center gap-2 rounded-none border border-white/10 bg-white/5 px-4 py-4 text-xs font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal transition-all"
        >
          Inoreader
        </a>
        <a
          href={newsblur}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center justify-center gap-2 rounded-none border border-white/10 bg-white/5 px-4 py-4 text-xs font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal transition-all"
        >
          NewsBlur
        </a>
      </div>

      {/* Raw feed fallback */}
      <div className="mt-12 text-center">
        <p className="text-xs text-white/40 uppercase tracking-widest">
          Prefer the raw XML?{" "}
          <Link href="/news/rss.xml" className="text-lsr-orange hover:text-white transition-colors underline underline-offset-4 decoration-lsr-orange/30 hover:decoration-white">
            Open Feed
          </Link>
        </p>
      </div>
      </div>
    </div>
  )
}
