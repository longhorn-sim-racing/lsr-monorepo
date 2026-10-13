"use client"

import Link from "next/link"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { MoreHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"
import { useConfirm, type ConfirmOptions } from "./dialog"

export type RowMenuItem =
  | { label: string; href: string; external?: boolean }
  | {
      label: string
      onSelect: () => unknown
      /** Red, and asks first. Pass the confirm text; deletes must always confirm. */
      destructive?: ConfirmOptions
      disabled?: boolean
    }
  | "separator"

/** The overflow (three dots) menu at the end of a row. Destructive items always confirm first. */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const confirm = useConfirm()
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label={label}
        title={label}
        className="flex size-7 items-center justify-center rounded-md text-admin-subtle outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-accent"
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-40 rounded-md border bg-popover p-1 text-[13px] shadow-lg" onClick={(event) => event.stopPropagation()}>
          {items.map((item, i) => {
            if (item === "separator") return <DropdownMenu.Separator key={i} className="my-1 h-px bg-admin-row" />
            const itemClass = "flex cursor-pointer items-center rounded px-2 py-1.5 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
            if ("href" in item) {
              return (
                <DropdownMenu.Item key={i} asChild className={itemClass}>
                  {item.external ? (
                    <a href={item.href} target="_blank" rel="noreferrer">
                      {item.label}
                    </a>
                  ) : (
                    <Link href={item.href}>{item.label}</Link>
                  )}
                </DropdownMenu.Item>
              )
            }
            return (
              <DropdownMenu.Item
                key={i}
                disabled={item.disabled}
                className={cn(itemClass, item.destructive && "text-tone-danger-foreground data-[highlighted]:bg-tone-danger")}
                onSelect={async () => {
                  if (item.destructive && !(await confirm({ tone: "danger", ...item.destructive }))) return
                  await item.onSelect()
                }}
              >
                {item.label}
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** Holds a row's icon buttons and menu, right-aligned, without triggering the row's click. */
export function RowActions({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-center justify-end gap-0.5", className)} onClick={(event) => event.stopPropagation()}>
      {children}
    </div>
  )
}
