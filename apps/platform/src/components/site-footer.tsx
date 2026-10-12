import Image from "next/image"
import Link from "next/link"
import { ArrowUpRight, Linkedin, Rss } from "lucide-react"
import { BrandIcon } from "@/components/brand-icon"
import { siInstagram, siTwitch, siDiscord } from "simple-icons/icons"
import { CONTACT_EMAIL, DISCORD_URL, INSTAGRAM_URL, LINKEDIN_URL, TWITCH_URL } from "@/lib/socials"

const COLUMNS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Race",
    links: [
      { href: "/events", label: "Events" },
      { href: "/lone-star-cup", label: "Lone Star Cup" },
      { href: "/drivers", label: "Drivers" },
    ],
  },
  {
    title: "Club",
    links: [
      { href: "/about", label: "About" },
      { href: "/news", label: "News" },
      { href: "/gallery", label: "Gallery" },
    ],
  },
  {
    title: "Support",
    links: [
      { href: "/sponsors", label: "Sponsors" },
      { href: "/sponsors#donate", label: "Donate" },
      { href: "/shop", label: "Merch" },
    ],
  },
]

const iconButton =
  "flex h-11 w-11 items-center justify-center border border-white/15 text-white/70 transition-colors hover:border-lsr-orange hover:text-lsr-orange"

const credits = [
  { name: "Gray Marshall", href: "https://graymarshall.dev" },
  { name: "Alexander Spears", href: "https://www.linkedin.com/in/alexander-spears/" },
  { name: "Arav Agarwal", href: "https://www.linkedin.com/in/arav-agarwal1/" },
]

export function SiteFooter() {
  const year = new Date().getFullYear()

  return (
    <footer role="contentinfo" className="relative overflow-hidden border-t border-white/10 bg-black">
      <div aria-hidden className="h-0.5 bg-gradient-to-r from-lsr-orange via-lsr-orange/40 to-transparent" />

      <div className="relative mx-auto max-w-6xl px-6 pt-16 pb-10 md:pt-20">
        <div className="grid gap-14 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)] lg:gap-16">
          {/* Brand */}
          <div className="space-y-7">
            <Link href="/" className="group inline-flex items-center gap-4">
              <Image src="/brand/logos/white_logo2.png" alt="" width={96} height={32} className="h-auto w-16" />
              <span className="flex flex-col">
                <span className="font-display text-2xl font-black uppercase italic leading-none text-white transition-colors group-hover:text-lsr-orange">
                  Longhorn Sim Racing
                </span>
                <span className="mt-1.5 font-sans text-[9px] font-bold uppercase tracking-[0.25em] text-white/45">
                  University of Texas at Austin
                </span>
              </span>
            </Link>
            <p className="max-w-sm font-sans text-sm leading-relaxed text-white/60">
              UT Austin&apos;s premier simulation racing organization. Performance. Engineering. Community.
            </p>
            <div className="space-y-1.5">
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="inline-flex items-center gap-1 font-sans text-sm font-bold text-white/80 transition-colors hover:text-lsr-orange"
              >
                {CONTACT_EMAIL}
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
              </a>
              <p className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">Austin, Texas</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" aria-label="Discord" className={iconButton}>
                <BrandIcon icon={siDiscord} className="h-4 w-4" />
              </a>
              <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" aria-label="Instagram" className={iconButton}>
                <BrandIcon icon={siInstagram} className="h-4 w-4" />
              </a>
              <a href={TWITCH_URL} target="_blank" rel="noopener noreferrer" aria-label="Twitch" className={iconButton}>
                <BrandIcon icon={siTwitch} className="h-4 w-4" />
              </a>
              <a href={LINKEDIN_URL} target="_blank" rel="noopener noreferrer" aria-label="LinkedIn" className={iconButton}>
                <Linkedin className="h-4 w-4" />
              </a>
              <Link href="/news/subscribe" aria-label="RSS and updates" className={iconButton}>
                <Rss className="h-4 w-4" />
              </Link>
            </div>
          </div>

          {/* Links */}
          <nav aria-label="Footer" className="grid grid-cols-2 gap-10 sm:grid-cols-3 lg:pt-2">
            {COLUMNS.map((column) => (
              <div key={column.title} className="space-y-5">
                <h3 className="font-sans text-[10px] font-bold uppercase tracking-[0.3em] text-lsr-orange">{column.title}</h3>
                <ul className="space-y-3">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="font-sans text-xs font-bold uppercase tracking-widest text-white/65 transition-colors hover:text-lsr-orange"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        {/* Bottom bar */}
        <div className="mt-16 flex flex-col gap-6 border-t border-white/10 pt-8 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <p>© {year} Longhorn Sim Racing</p>
            <p>University of Texas at Austin · A 501(c)(3) nonprofit</p>
          </div>
          <div className="space-y-2 md:text-right">
            <div className="flex gap-6 md:justify-end">
              <Link href="/privacy" className="transition-colors hover:text-white">Privacy</Link>
              <Link href="/terms" className="transition-colors hover:text-white">Terms</Link>
            </div>
            <p>
            Built with Next.js • Vercel • Made by{" "}
            {credits.map((person, i) => (
              <span key={person.name}>
                <a href={person.href} target="_blank" rel="noreferrer" className="whitespace-nowrap text-white/60 transition-colors hover:text-white">
                  {person.name}
                </a>
                {i < credits.length - 1 ? ", " : ""}
              </span>
            ))}
            </p>
          </div>
        </div>
      </div>

      {/* Oversized outline wordmark along the bottom edge */}
      <p
        aria-hidden
        className="pointer-events-none -mb-[1.5vw] select-none whitespace-nowrap text-center font-display text-[8vw] font-black uppercase italic leading-none text-transparent [-webkit-text-stroke:1px_rgba(255,255,255,0.08)]"
      >
        Longhorn Sim Racing
      </p>
    </footer>
  )
}
