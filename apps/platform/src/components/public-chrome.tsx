"use client"

import { usePathname } from "next/navigation"

/** Renders the public site's banner, header, footer and prompts everywhere except the admin console, which has its own shell. */
export function PublicChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  if (pathname === "/admin" || pathname?.startsWith("/admin/")) return null
  return <>{children}</>
}
