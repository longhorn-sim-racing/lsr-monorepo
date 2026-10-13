"use client"

import * as React from "react"
import * as Popover from "@radix-ui/react-popover"
import { Command } from "cmdk"
import { ChevronsUpDown, Plus, X } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Pick several tags from a list, or type a new one to create it. Chosen tags show as removable chips.
 * Generic enough to move into the admin kit (as a "multi combobox") if another page needs one.
 */
export function TagPicker({
  value,
  onChange,
  options,
  placeholder = "Add a tag",
  id,
  disabled,
  className,
}: {
  value: string[]
  onChange: (tags: string[]) => void
  /** Existing tags to choose from */
  options: string[]
  placeholder?: string
  id?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  const typed = query.trim()
  const lower = typed.toLowerCase()
  const available = options.filter((tag) => !value.some((v) => v.toLowerCase() === tag.toLowerCase()))
  const matches = lower ? available.filter((tag) => tag.toLowerCase().includes(lower)) : available
  const exists = [...options, ...value].some((tag) => tag.toLowerCase() === lower)

  const add = (tag: string) => {
    if (!value.some((v) => v.toLowerCase() === tag.toLowerCase())) onChange([...value, tag])
    setQuery("")
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery("")
        }}
      >
        <Popover.Trigger
          id={id}
          disabled={disabled}
          className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-card px-2.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="truncate text-admin-subtle">{placeholder}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-admin-subtle" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={4} className="z-50 w-[min(320px,calc(100vw-2rem))] rounded-md border bg-popover shadow-lg">
            <Command shouldFilter={false} label="Tags" className="text-[13px]">
              <div className="border-b px-2.5">
                <Command.Input
                  autoFocus
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search or create a tag"
                  className="h-9 w-full bg-transparent outline-none placeholder:text-admin-subtle"
                />
              </div>
              <Command.List className="max-h-64 overflow-y-auto p-1">
                {typed && !exists && (
                  <Command.Item
                    value={`create:${typed}`}
                    onSelect={() => add(typed)}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 data-[selected=true]:bg-accent"
                  >
                    <Plus className="size-3.5 text-admin-subtle" aria-hidden />
                    Create &ldquo;{typed}&rdquo;
                  </Command.Item>
                )}
                {matches.map((tag) => (
                  <Command.Item
                    key={tag}
                    value={tag}
                    onSelect={() => add(tag)}
                    className="flex cursor-pointer items-center rounded px-2 py-1.5 data-[selected=true]:bg-accent"
                  >
                    {tag}
                  </Command.Item>
                ))}
                {matches.length === 0 && !typed && <p className="px-2 py-3 text-xs text-admin-subtle">No other tags yet. Type to create one.</p>}
                {matches.length === 0 && typed && exists && <p className="px-2 py-3 text-xs text-admin-subtle">Already added.</p>}
              </Command.List>
            </Command>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Chosen tags">
          {value.map((tag) => (
            <li key={tag} className="flex items-center gap-1 rounded-full border bg-admin-surface py-0.5 pl-2.5 pr-1 text-xs font-medium">
              {tag}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(value.filter((t) => t !== tag))}
                aria-label={`Remove ${tag}`}
                className="flex size-4 items-center justify-center rounded-full text-admin-subtle hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
