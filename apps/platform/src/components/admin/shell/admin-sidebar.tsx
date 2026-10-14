"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { ADMIN_NAV, findNavItem } from "./admin-nav"

export type ShellUser = {
  displayName: string
  avatarUrl: string | null
  roleLabel: string
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?"
}

/** The sidebar's contents: brand, search, grouped navigation and the signed-in officer. Used on desktop and in the phone drawer. */
export function AdminSidebarContent({ user, onSearch, onNavigate }: { user: ShellUser; onSearch: () => void; onNavigate?: () => void }) {
  const pathname = usePathname()
  const activeHref = findNavItem(pathname)?.item.href

  return (
    <div className="flex h-full flex-col gap-3.5 px-3 py-3.5">
      <Link href="/admin" onClick={onNavigate} className="flex items-center gap-2.5 rounded-md px-1.5 py-0.5 text-white">
        {/* The sidebar is dark in both themes, so the white logo always shows */}
        <Image src="/brand/logos/white_logo2.png" alt="" width={972} height={326} priority className="h-[22px] w-auto shrink-0" />
        <span className="flex flex-col">
          <span className="font-display text-base font-semibold leading-tight">Admin</span>
          <span className="text-[11px] text-admin-nav-muted">Longhorn Sim Racing</span>
        </span>
      </Link>

      <button
        type="button"
        onClick={onSearch}
        className="flex h-8 items-center gap-2 rounded-md border border-admin-nav-border bg-admin-nav-input px-2.5 text-[13px] text-admin-nav-foreground transition-colors hover:text-white"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 whitespace-nowrap text-left">Jump to</span>
        <kbd className="rounded border border-admin-nav-border px-1.5 font-sans text-[11px] text-admin-nav-muted">Ctrl K</kbd>
      </button>

      <nav aria-label="Admin" className="flex flex-col gap-2.5">
        {ADMIN_NAV.map((group, i) => (
          <div key={group.label ?? i} className="flex flex-col gap-px">
            {group.label && <span className="px-2 pb-1 text-[11px] font-semibold text-admin-nav-muted">{group.label}</span>}
            {group.items.map((item) => {
              const active = item.href === activeHref
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors",
                    active ? "bg-admin-nav-active font-semibold text-white" : "font-medium hover:bg-admin-nav-active/60 hover:text-white",
                  )}
                >
                  <span aria-hidden className={cn("size-1.5 rounded-full", active ? "bg-primary" : "bg-transparent")} />
                  {item.title}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="mt-auto flex items-center gap-2.5 border-t border-admin-nav-active px-1.5 pt-2.5">
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- avatars come from several hosts
          <img src={user.avatarUrl} alt="" className="size-7 rounded-full object-cover" />
        ) : (
          <span className="flex size-7 items-center justify-center rounded-full bg-admin-nav-border text-[11px] font-semibold text-white">
            {initials(user.displayName)}
          </span>
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-semibold text-white">{user.displayName}</span>
          <span className="text-xs text-admin-nav-muted">{user.roleLabel}</span>
        </span>
      </div>
    </div>
  )
}
