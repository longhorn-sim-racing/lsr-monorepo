"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { ArrowUpRight, Menu, X } from "lucide-react"
import { siDiscord, siInstagram, siTwitch } from "simple-icons/icons"
import { BrandIcon } from "@/components/brand-icon"
import { MORE_NAV, PRIMARY_NAV, isActivePath } from "@/components/site-nav"
import { CONTACT_EMAIL, DISCORD_URL, INSTAGRAM_URL, TWITCH_URL } from "@/lib/socials"

const SOCIALS = [
  { href: DISCORD_URL, label: "Discord", icon: siDiscord },
  { href: INSTAGRAM_URL, label: "Instagram", icon: siInstagram },
  { href: TWITCH_URL, label: "Twitch", icon: siTwitch },
]

/** The phone menu: a full-screen panel over the page, opened from the header. */
export function MobileNav() {
  const pathname = usePathname()
  const links = [...PRIMARY_NAV, ...MORE_NAV]

  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger
        aria-label="Open menu"
        className="flex h-11 w-11 items-center justify-center border border-white/15 text-white transition-colors hover:border-lsr-orange hover:text-lsr-orange"
      >
        <Menu className="h-5 w-5" />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-lsr-charcoal text-white data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-4 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <DialogPrimitive.Title className="sr-only">Site menu</DialogPrimitive.Title>
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-6">
            <DialogPrimitive.Close asChild>
              <Link href="/" aria-label="Longhorn Sim Racing home">
                <Image src="/brand/logos/white_logo2.png" alt="" width={96} height={32} className="h-auto w-14" />
              </Link>
            </DialogPrimitive.Close>
            <DialogPrimitive.Close
              aria-label="Close menu"
              className="flex h-11 w-11 items-center justify-center border border-white/15 text-white transition-colors hover:border-lsr-orange hover:text-lsr-orange"
            >
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
          </div>

          <nav aria-label="Menu" className="flex-1 px-6 py-6">
            <ul>
              {links.map((link, i) => {
                const active = isActivePath(pathname, link.href)
                return (
                  <li key={link.href} className="border-b border-white/10">
                    <DialogPrimitive.Close asChild>
                      <Link
                        href={link.href}
                        aria-current={active ? "page" : undefined}
                        className="group flex items-baseline gap-4 py-4"
                      >
                        <span className="w-8 font-display font-black italic text-sm text-lsr-orange">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span
                          className={`font-display font-black italic text-4xl uppercase leading-none transition-colors ${
                            active ? "text-lsr-orange" : "text-white group-hover:text-lsr-orange"
                          }`}
                        >
                          {link.label === "LSC" ? "Lone Star Cup" : link.label}
                        </span>
                      </Link>
                    </DialogPrimitive.Close>
                  </li>
                )
              })}
            </ul>
          </nav>

          <div className="shrink-0 border-t border-white/10 px-6 py-6">
            <div className="flex gap-2">
              {SOCIALS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  className="flex h-11 w-11 items-center justify-center border border-white/15 text-white/70 transition-colors hover:border-lsr-orange hover:text-lsr-orange"
                >
                  <BrandIcon icon={s.icon} className="h-4 w-4" />
                </a>
              ))}
            </div>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="mt-4 inline-flex items-center gap-1.5 font-sans text-xs font-bold uppercase tracking-widest text-white/60 transition-colors hover:text-lsr-orange"
            >
              {CONTACT_EMAIL}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
