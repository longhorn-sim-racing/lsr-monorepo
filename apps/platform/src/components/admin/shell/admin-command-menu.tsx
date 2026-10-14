"use client"

import { useRouter } from "next/navigation"
import * as Dialog from "@radix-ui/react-dialog"
import { Command } from "cmdk"
import { Moon, Search, Sun } from "lucide-react"
import type { AdminTheme } from "@/lib/admin-theme"
import { ADMIN_NAV } from "./admin-nav"

type CommandMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  theme: AdminTheme
  onToggleTheme: () => void
}

/** Ctrl/Cmd K: jump to any admin page by name or keyword, or switch between light and dark. */
export function AdminCommandMenu({ open, onOpenChange, theme, onToggleTheme }: CommandMenuProps) {
  const router = useRouter()

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <Dialog.Title className="sr-only">Jump to a page</Dialog.Title>
          <Dialog.Description className="sr-only">Type to filter admin pages, then press Enter.</Dialog.Description>
          <Command label="Jump to a page" className="flex flex-col text-[13px]">
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 text-admin-subtle" aria-hidden />
              <Command.Input autoFocus placeholder="Search admin pages" className="h-11 flex-1 bg-transparent outline-none placeholder:text-admin-subtle" />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-muted-foreground">No pages match.</Command.Empty>
              {ADMIN_NAV.map((group, i) => (
                <Command.Group
                  key={group.label ?? i}
                  heading={group.label}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-admin-subtle"
                >
                  {group.items.map((item) => (
                    <Command.Item
                      key={item.href}
                      value={[item.title, group.label, ...(item.keywords ?? [])].filter(Boolean).join(" ")}
                      onSelect={() => {
                        onOpenChange(false)
                        router.push(item.href)
                      }}
                      className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 data-[selected=true]:bg-accent"
                    >
                      <span className="font-medium">{item.title}</span>
                      {group.label && <span className="text-xs text-admin-subtle">{group.label}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
              <Command.Group
                heading="Appearance"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-admin-subtle"
              >
                <Command.Item
                  value="theme dark light mode appearance"
                  onSelect={() => {
                    onOpenChange(false)
                    onToggleTheme()
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 data-[selected=true]:bg-accent"
                >
                  {theme === "dark" ? <Sun className="size-3.5 text-admin-subtle" aria-hidden /> : <Moon className="size-3.5 text-admin-subtle" aria-hidden />}
                  <span className="font-medium">{theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}</span>
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
