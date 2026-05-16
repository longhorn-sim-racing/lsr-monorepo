import Link from "next/link"
import { Rss, ExternalLink, Linkedin } from "lucide-react"
import { BrandIcon } from "@/components/brand-icon"
import { siInstagram, siYoutube, siTwitch, siDiscord } from "simple-icons/icons"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

export function SiteFooter() {
  const year = new Date().getFullYear()

  return (
    <footer role="contentinfo" className="border-t border-white/5 bg-black">
      <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
          {/* Brand */}
          <div className="space-y-6">
            <Link href="/" className="flex flex-col gap-1 group">
              <div className="flex flex-col">
                <span className="font-display font-black italic text-xl tracking-normal leading-none uppercase text-white group-hover:text-[#FF8000] transition-colors">
                  Longhorn Sim Racing
                </span>
                <span className="font-sans font-bold text-[7px] uppercase tracking-[0.2em] text-white/40 leading-none mt-1">
                  University of Texas at Austin
                </span>
              </div>
            </Link>
            <p className="font-sans text-xs text-white/30 uppercase tracking-widest leading-loose max-w-[240px]">
              UT Austin&apos;s premier simulation racing organization. Performance. Engineering. Community.
            </p>
          </div>

          {/* Quick links */}
          <div className="space-y-6">
            <h3 className="font-sans font-black text-[10px] uppercase tracking-[0.3em] text-white/20">The Grid</h3>
            <nav aria-label="Footer" className="flex flex-col gap-3 text-xs font-bold uppercase tracking-widest">
              <Link href="/about" className="text-white/60 hover:text-lsr-orange transition-colors">About</Link>
              <Link href="/news" className="text-white/60 hover:text-lsr-orange transition-colors">News</Link>
              <Link href="/events" className="text-white/60 hover:text-lsr-orange transition-colors">Events</Link>
              <Link href="/drivers" className="text-white/60 hover:text-lsr-orange transition-colors">Drivers</Link>
              <Link href="/shop" className="text-white/60 hover:text-lsr-orange transition-colors">Merch</Link>
              <Link href="/gallery" className="text-white/60 hover:text-lsr-orange transition-colors">Gallery</Link>
              <Link href="/sponsors" className="text-white/60 hover:text-lsr-orange transition-colors">Sponsors</Link>
              <Link href="/lone-star-cup" className="text-white/60 hover:text-lsr-orange transition-colors">LSC</Link>
              <Link href="/privacy" className="text-white/60 hover:text-lsr-orange transition-colors">Privacy</Link>
              <Link href="/terms" className="text-white/60 hover:text-lsr-orange transition-colors">Terms</Link>
            </nav>
          </div>

          {/* Contact */}
          <div className="space-y-6 text-xs">
            <h3 className="font-sans font-black text-[10px] uppercase tracking-[0.3em] text-white/20">Headquarters</h3>
            <div className="space-y-4">
              <p className="text-white/60 font-bold uppercase tracking-widest">Austin, Texas</p>
              <a
                href="mailto:info@longhornsimracing.org"
                className="flex items-center gap-3 text-white/60 hover:text-lsr-orange transition-colors font-bold uppercase tracking-widest group"
              >
                info@longhornsimracing.org
              </a>
            </div>
          </div>

          {/* Social */}
          <div className="space-y-6 text-xs">
            <h3 className="font-sans font-black text-[10px] uppercase tracking-[0.3em] text-white/20">Network</h3>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-3">
              <li>
                <a
                  href="https://discord.gg/5Uv9YwpnFz"
                  target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 text-white/60 hover:text-lsr-orange transition-colors font-bold uppercase tracking-widest"
                >
                  <BrandIcon icon={siDiscord} className="h-3 w-3" />
                  Discord
                </a>
              </li>
              <li>
                <a
                  href="https://instagram.com/longhorn_sim_racing"
                  target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 text-white/60 hover:text-lsr-orange transition-colors font-bold uppercase tracking-widest"
                >
                  <BrandIcon icon={siInstagram} className="h-3 w-3" />
                  Insta
                </a>
              </li>
              <li>
                <a
                  href="https://www.twitch.tv/longhorn_sim_racing"
                  target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 text-white/60 hover:text-lsr-orange transition-colors font-bold uppercase tracking-widest"
                >
                  <BrandIcon icon={siTwitch} className="h-3 w-3" />
                  Twitch
                </a>
              </li>
              <li>
                <a
                  href="https://www.linkedin.com/company/longhorn-sim-racing"
                  target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 text-white/60 hover:text-lsr-orange transition-colors font-bold uppercase tracking-widest"
                >
                  <ExternalLink className="h-3 w-3" />
                  LinkedIn
                </a>
              </li>
              <li>
                <Link href="/news/subscribe" className="flex items-center gap-2 text-white/60 hover:text-lsr-orange transition-colors font-bold uppercase tracking-widest">
                  <Rss className="h-3 w-3" />
                  RSS
                </Link>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div
          className="mt-20 flex flex-col items-start justify-between gap-6 border-t border-white/5 pt-10 text-[9px] font-bold uppercase tracking-[0.2em] text-white/20 sm:flex-row">
          <p>© {year} Longhorn Sim Racing · University of Texas at Austin</p>
          <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-6">
            <p>Built with Next.js • Vercel • Made by{" "}
              <a
                href="https://graymarshall.dev"
                target="_blank"
                rel="noreferrer"
                className="text-white/40 hover:text-white transition-colors"
              >
                Gray Marshall
              </a>
              ,{" "}
              <a
                href="https://www.linkedin.com/in/alexander-spears/"
                target="_blank"
                rel="noreferrer"
                className="text-white/40 hover:text-white transition-colors"
              >
                Alexander Spears
              </a>
              ,{" "}
              <a
                href="https://www.linkedin.com/in/arav-agarwal1/"
                target="_blank"
                rel="noreferrer"
                className="text-white/40 hover:text-white transition-colors"
              >
                Arav Agarwal
              </a>
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}
