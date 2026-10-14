// The site's main navigation, shared by the header (desktop bar and phone menu) and the footer.

export type NavLink = { href: string; label: string }

/** Shown in the header bar on desktop. */
export const PRIMARY_NAV: NavLink[] = [
  { href: "/events", label: "Events" },
  { href: "/lone-star-cup", label: "LSC" },
  { href: "/drivers", label: "Drivers" },
  { href: "/news", label: "News" },
  { href: "/about", label: "About" },
]

/** Under "More" on desktop. */
export const MORE_NAV: NavLink[] = [
  { href: "/gallery", label: "Gallery" },
  { href: "/sponsors", label: "Sponsors" },
  { href: "/shop", label: "Merch" },
]

export function isActivePath(pathname: string | null, href: string): boolean {
  if (!pathname) return false
  return pathname === href || pathname.startsWith(`${href}/`)
}
