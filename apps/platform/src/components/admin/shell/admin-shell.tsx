"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import * as Dialog from "@radix-ui/react-dialog"
import { Menu, Search, X } from "lucide-react"
import { AdminSidebarContent, type ShellUser } from "./admin-sidebar"
import { AdminCommandMenu } from "./admin-command-menu"
import { findNavItem } from "./admin-nav"

/**
 * The admin console's frame: a dark sidebar (a drawer on phones), a slim top bar with breadcrumbs, and the
 * light workspace. `admin-light` switches the whole document to the admin theme (see globals.css).
 */
export function AdminShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const pathname = usePathname()
  const [commandOpen, setCommandOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setCommandOpen((open) => !open)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const openSearch = () => {
    setDrawerOpen(false)
    setCommandOpen(true)
  }
  const match = findNavItem(pathname)

  return (
    <div className="admin-light flex min-h-dvh bg-background font-sans text-sm text-foreground">
      <aside className="sticky top-0 hidden h-dvh w-[236px] shrink-0 overflow-y-auto bg-admin-nav text-admin-nav-foreground md:block">
        <AdminSidebarContent user={user} onSearch={openSearch} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-11 items-center gap-3 border-b bg-card px-4 md:px-6">
          <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <Dialog.Trigger
              className="-ml-1.5 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent md:hidden"
              aria-label="Open menu"
            >
              <Menu className="size-4" />
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 md:hidden" />
              <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-[272px] max-w-[85vw] overflow-y-auto bg-admin-nav text-admin-nav-foreground shadow-xl md:hidden">
                <Dialog.Title className="sr-only">Admin menu</Dialog.Title>
                <Dialog.Description className="sr-only">Pages in the admin console</Dialog.Description>
                <Dialog.Close className="absolute right-2 top-3 flex size-8 items-center justify-center rounded-md text-admin-nav-muted hover:text-white" aria-label="Close menu">
                  <X className="size-4" />
                </Dialog.Close>
                <AdminSidebarContent user={user} onSearch={openSearch} onNavigate={() => setDrawerOpen(false)} />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          <nav aria-label="Breadcrumb" className="min-w-0 truncate text-[13px] text-muted-foreground">
            {match?.group.label && match.group.label !== match.item.title && (
              <>
                {match.group.label} <span className="text-admin-nav-muted">/</span>{" "}
              </>
            )}
            <span className="font-semibold text-foreground">{match?.item.title ?? "Admin"}</span>
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={openSearch}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent md:hidden"
              aria-label="Search admin pages"
            >
              <Search className="size-4" />
            </button>
            <Link href="/" className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
              View site
            </Link>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-4 md:px-6 md:py-5">{children}</main>
      </div>

      <AdminCommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  )
}
