"use client"

import Link from "next/link"
import Image from "next/image"
import { UserMenuClient } from "@/components/user-menu-client"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChevronDown, ShoppingCart } from "lucide-react"
import { usePathname } from "next/navigation"
import { User } from "@prisma/client"
import { useCart } from "@/lib/shopify/CartContext"
import { WishlistIndicator } from "@/components/shop/WishlistIndicator"
import { NotificationBell } from "@/components/notification-bell"
import { MobileNav } from "@/components/mobile-nav"
import { MORE_NAV, PRIMARY_NAV, isActivePath } from "@/components/site-nav"
import { motion, AnimatePresence } from "framer-motion"

const linkBase = "group/link relative px-2 py-2 lg:px-3 font-sans text-[11px] font-bold uppercase tracking-[0.2em] transition-colors"

/** The orange bar under a nav link: shown for the current section, grows in on hover otherwise. */
function ActiveBar({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={`absolute inset-x-2 -bottom-0.5 h-0.5 lg:inset-x-3 origin-left bg-lsr-orange transition-transform duration-300 ${
        active ? "scale-x-100" : "scale-x-0 group-hover/link:scale-x-100"
      }`}
    />
  )
}

export function SiteHeader({ user, roles, activeTierKey }: { user: User | null, roles: string[], activeTierKey: string | null }) {
  const pathname = usePathname()
  const isShopPage = pathname.startsWith("/shop")
  const { cartCount } = useCart()
  const showCart = cartCount > 0 || isShopPage
  const moreActive = MORE_NAV.some((link) => isActivePath(pathname, link.href))

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-lsr-charcoal/95 backdrop-blur-md">
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6 md:h-20">
        <Link href="/" aria-label="Longhorn Sim Racing home" className="group shrink-0">
          <Image
            src="/brand/logos/white_logo2.png"
            alt=""
            width={96}
            height={32}
            className="h-auto w-14 transition-transform duration-500 group-hover:scale-105 md:w-[72px]"
            priority
          />
        </Link>

        <div className="flex items-center gap-2 md:gap-4">
          {/* Desktop navigation */}
          <div className="hidden items-center md:flex">
            {PRIMARY_NAV.map((link) => {
              const active = isActivePath(pathname, link.href)
              const accent = link.href === "/lone-star-cup"
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={`${linkBase} ${active ? "text-white" : accent ? "text-lsr-orange hover:text-white" : "text-white/65 hover:text-white"}`}
                >
                  {link.label}
                  <ActiveBar active={active} />
                </Link>
              )
            })}
            <DropdownMenu>
              <DropdownMenuTrigger
                className={`${linkBase} flex items-center gap-1.5 outline-none ${moreActive ? "text-white" : "text-white/65 hover:text-white"}`}
              >
                More
                <ChevronDown className="h-3 w-3 opacity-60" />
                <ActiveBar active={moreActive} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={12} className="min-w-[180px] rounded-none border-white/10 bg-lsr-charcoal p-1.5">
                {MORE_NAV.map((link) => {
                  const active = isActivePath(pathname, link.href)
                  return (
                    <DropdownMenuItem key={link.href} asChild className="cursor-pointer rounded-none focus:bg-lsr-orange focus:text-white">
                      <Link
                        href={link.href}
                        aria-current={active ? "page" : undefined}
                        className={`px-3 py-2.5 font-sans text-[11px] font-bold uppercase tracking-[0.2em] ${active ? "text-lsr-orange" : "text-white/80"}`}
                      >
                        {link.label}
                      </Link>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="hidden h-6 w-px bg-white/10 md:block" />

          <div className="flex items-center gap-2 md:gap-3">
            {/* Notification bell - only for authenticated users */}
            {user && <NotificationBell />}
            <WishlistIndicator />
            {/* Cart indicator - only show on shop pages or when cart has items */}
            <AnimatePresence>
              {showCart && (
                <motion.div
                  layout
                  initial={{ opacity: 0, scale: 0.5, width: 0 }}
                  animate={{ opacity: 1, scale: 1, width: "auto" }}
                  exit={{ opacity: 0, scale: 0.5, width: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <Link
                    href="/shop/cart"
                    className="relative text-white/70 hover:text-lsr-orange transition-colors p-2 block"
                    aria-label={`Shopping cart with ${cartCount} items`}
                  >
                    <ShoppingCart className="h-5 w-5" />
                    {cartCount > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 bg-lsr-orange text-white text-[10px] font-bold rounded-full h-5 w-5 flex items-center justify-center animate-in zoom-in-50 duration-200">
                        {cartCount > 99 ? '99+' : cartCount}
                      </span>
                    )}
                  </Link>
                </motion.div>
              )}
            </AnimatePresence>

            <UserMenuClient user={user} roles={roles} activeTierKey={activeTierKey} />

            <div className="md:hidden">
              <MobileNav />
            </div>
          </div>
        </div>
      </nav>
    </header>
  )
}
