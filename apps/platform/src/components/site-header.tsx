"use client"

import Link from "next/link"
import Image from "next/image"
import { UserMenuClient } from "@/components/user-menu-client"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { ChevronDown, Menu, ShoppingCart } from "lucide-react"
import { usePathname } from "next/navigation"
import { User } from "@prisma/client"
import { useCart } from "@/lib/shopify/CartContext"
import { WishlistIndicator } from "@/components/shop/WishlistIndicator"
import { NotificationBell } from "@/components/notification-bell"
import { motion, AnimatePresence } from "framer-motion"

export function SiteHeader({ user, roles, activeTierKey }: { user: User | null, roles: string[], activeTierKey: string | null }) {
  const pathname = usePathname()
  const isHome = pathname === "/"
  const isShopPage = pathname.startsWith("/shop")
  const { cartCount } = useCart()
  const showCart = cartCount > 0 || isShopPage

  return (
    <header className="sticky top-0 z-50 bg-lsr-charcoal/95 backdrop-blur-md border-b border-white/5">
      <nav className="mx-auto max-w-6xl flex h-20 items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-4 group">
          {/* Logo Image: Always visible */}
          <div className="relative">
            <Image
              src="/brand/logos/white_logo2.png"
              alt="LSR logo"
              width={64}
              height={64}
              className="rounded-none transition-transform group-hover:scale-110 duration-500"
              priority
            />
          </div>
          
          {/* Brand Text: Hidden on Home, Hidden on Mobile (non-home), Visible on Desktop (non-home) */}
          <div className={`flex flex-col ${isHome ? 'hidden' : 'hidden sm:flex'}`}>
            <span className="font-display font-black italic text-lg sm:text-2xl tracking-normal leading-none uppercase text-white whitespace-nowrap">
              Longhorn Sim Racing
            </span>
            <span className="font-sans font-bold text-[7px] sm:text-[8px] uppercase tracking-[0.2em] sm:tracking-[0.25em] text-white/50 leading-none mt-1 whitespace-nowrap">
              University of Texas at Austin
            </span>
          </div>
        </Link>

        <div className="flex items-center gap-6">
          {/* Desktop navigation links */}
          <div className="hidden md:flex items-center gap-8 font-sans font-bold text-[10px] uppercase tracking-[0.25em] text-white/70">
            <Link href="/events" className="hover:text-lsr-orange transition-colors relative group/link">
              Events
              <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-lsr-orange transition-all group-hover/link:w-full" />
            </Link>
            {!isShopPage && (
              <Link href="/drivers" className="hover:text-lsr-orange transition-colors relative group/link">
                Drivers
                <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-lsr-orange transition-all group-hover/link:w-full" />
              </Link>
            )}
            <Link href="/shop" className="hover:text-lsr-orange transition-colors relative group/link">
              Merch
              <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-lsr-orange transition-all group-hover/link:w-full" />
            </Link>
            <Link href="/lone-star-cup" className="hover:text-lsr-orange transition-colors relative group/link text-lsr-orange/80">
              LSC
              <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-lsr-orange transition-all group-hover/link:w-full" />
            </Link>
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-1.5 hover:text-lsr-orange transition-colors outline-none group/more">
                <span>More</span>
                <ChevronDown className="h-3 w-3 opacity-50 group-hover/more:opacity-100 transition-opacity" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-lsr-charcoal border-white/10 rounded-none p-2 min-w-[160px]">
                {isShopPage && (
                  <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                    <Link href="/drivers" className="font-sans font-bold text-[9px] uppercase tracking-widest py-2">Drivers</Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                  <Link href="/news" className="font-sans font-bold text-[9px] uppercase tracking-widest py-2">News</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                  <Link href="/about" className="font-sans font-bold text-[9px] uppercase tracking-widest py-2">About</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                  <Link href="/gallery" className="font-sans font-bold text-[9px] uppercase tracking-widest py-2">Gallery</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                  <Link href="/sponsors" className="font-sans font-bold text-[9px] uppercase tracking-widest py-2">Sponsors</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="h-6 w-px bg-white/10 hidden md:block" />

          {/* User menu */}
          <div className="flex items-center gap-4">
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
            
            {/* Mobile hamburger menu */}
            <div className="md:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="hover:bg-white/5 rounded-none">
                    <Menu className="h-6 w-6" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-lsr-charcoal border-white/10 rounded-none w-56 p-2">
                  <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                    <Link href="/about" className="font-sans font-bold text-[10px] uppercase tracking-widest py-3">About</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                    <Link href="/drivers" className="font-sans font-bold text-[10px] uppercase tracking-widest py-3">Drivers</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                    <Link href="/events" className="font-sans font-bold text-[10px] uppercase tracking-widest py-3">Events</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                    <Link href="/shop" className="font-sans font-bold text-[10px] uppercase tracking-widest py-3">Merch</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                    <Link href="/gallery" className="font-sans font-bold text-[10px] uppercase tracking-widest py-3">Gallery</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                    <Link href="/news" className="font-sans font-bold text-[10px] uppercase tracking-widest py-3">News</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                    <Link href="/sponsors" className="font-sans font-bold text-[10px] uppercase tracking-widest py-3">Sponsors</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="focus:bg-lsr-orange focus:text-white rounded-none cursor-pointer">
                    <Link href="/lone-star-cup" className="font-sans font-bold text-[10px] uppercase tracking-widest py-3 text-lsr-orange">LSC</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </nav>
    </header>
  )
}
