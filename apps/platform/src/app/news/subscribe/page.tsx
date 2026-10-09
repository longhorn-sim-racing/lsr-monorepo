import Link from "next/link"
import type { Metadata } from "next"
import { ArrowLeft, ArrowUpRight, Mail, MessageSquare, Rss } from "lucide-react"
import { siInstagram } from "simple-icons/icons"
import { BrandIcon } from "@/components/brand-icon"
import { INSTAGRAM_PROFILE_URL } from "@/lib/instagram"
import { CopyButton } from "./copy-button"

export const metadata: Metadata = {
  title: "Follow LSR",
  description: "Every way to keep up with Longhorn Sim Racing: Instagram, Discord, email and the news RSS feed.",
  alternates: { canonical: "/news/subscribe" },
}

const DISCORD_URL = "https://discord.gg/5Uv9YwpnFz"

export default function SubscribePage() {
  // The same base the sitemap uses, so the server and the browser show one URL
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.longhornsimracing.org").replace(/\/$/, "")
  const feedUrl = `${base}/news/rss.xml`
  const encoded = encodeURIComponent(feedUrl)
  const readers = [
    { name: "Feedly", href: `https://feedly.com/i/subscription/feed/${encoded}` },
    { name: "Inoreader", href: `https://www.inoreader.com/?add_feed=${encoded}` },
    { name: "NewsBlur", href: `https://www.newsblur.com/?url=${encoded}` },
  ]
  const channels = [
    {
      title: "Instagram",
      text: "Race days, photos and reels. The quickest way to see what we're up to.",
      href: INSTAGRAM_PROFILE_URL,
      action: "Follow",
      icon: <BrandIcon icon={siInstagram} label="" className="h-5 w-5" />,
      external: true,
    },
    {
      title: "Discord",
      text: "Where everything gets announced first, plus race coordination and the paddock chat.",
      href: DISCORD_URL,
      action: "Join",
      icon: <MessageSquare className="h-5 w-5" aria-hidden />,
      external: true,
    },
    {
      title: "Email",
      text: "Make an account and turn on club updates to get club announcements by email.",
      href: "/account#email",
      action: "Email settings",
      icon: <Mail className="h-5 w-5" aria-hidden />,
      external: false,
    },
  ]

  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      <div className="relative overflow-hidden border-b border-white/10 bg-black/25">
        <div className="absolute inset-0 opacity-[0.04] [background-image:repeating-linear-gradient(45deg,white_0px,white_1px,transparent_1px,transparent_10px)] pointer-events-none" />
        <div className="relative mx-auto max-w-5xl px-6 md:px-8 pt-10 pb-12 md:pt-14 md:pb-16">
          <Link href="/news" className="group inline-flex items-center gap-2 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/60 transition-colors hover:text-lsr-orange">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-1" />
            All news
          </Link>
          <p className="mt-8 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Stay in the loop</p>
          <h1 className="mt-3 font-display font-black italic text-5xl md:text-7xl uppercase leading-[0.9]">
            Follow <span className="text-lsr-orange">LSR</span>
          </h1>
          <p className="mt-5 max-w-xl font-sans text-base md:text-lg leading-relaxed text-white/70">
            Pick how you want to hear from us. Instagram and Discord cover most of it; the RSS feed is there if you live in a reader.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-6 md:px-8 py-12 md:py-16 space-y-14">
        <ul className="grid gap-3 md:grid-cols-3">
          {channels.map((c) => (
            <li key={c.title}>
              <a
                href={c.href}
                {...(c.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="group relative flex h-full flex-col border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-lsr-orange/60"
              >
                <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
                <span aria-hidden className="flex h-11 w-11 items-center justify-center bg-lsr-orange/15 text-lsr-orange">{c.icon}</span>
                <h2 className="mt-5 font-display font-black italic text-2xl uppercase">{c.title}</h2>
                <p className="mt-2 flex-1 font-sans text-sm leading-relaxed text-white/65">{c.text}</p>
                <span className="mt-6 inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white group-hover:text-lsr-orange">
                  {c.action}
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                </span>
              </a>
            </li>
          ))}
        </ul>

        <section aria-labelledby="rss-heading" className="relative border border-white/10 bg-white/[0.02] p-6 md:p-8">
          <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
          <div className="flex items-center gap-3">
            <Rss className="h-5 w-5 text-lsr-orange" aria-hidden />
            <h2 id="rss-heading" className="font-display font-black italic text-2xl uppercase">News RSS feed</h2>
          </div>
          <p className="mt-2 font-sans text-sm text-white/65">Every news post, in any feed reader.</p>
          <div className="mt-6 flex flex-col items-stretch gap-3 md:flex-row md:items-center">
            <code className="min-w-0 flex-1 overflow-x-auto border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm text-white/85">{feedUrl}</code>
            <CopyButton value={feedUrl} />
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <span className="mr-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">Add to</span>
            {readers.map((r) => (
              <a
                key={r.name}
                href={r.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center border border-white/15 px-4 font-sans text-xs font-bold uppercase tracking-[0.15em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal"
              >
                {r.name}
              </a>
            ))}
            <Link href="/news/rss.xml" className="w-full font-sans text-xs font-bold text-lsr-orange underline-offset-4 hover:text-white hover:underline sm:ml-auto sm:w-auto">
              Open the raw feed
            </Link>
          </div>
        </section>
      </div>
    </div>
  )
}
