"use client"

import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"

/** A search box with an icon and a clear button. Controlled; debounce in the caller if it hits the server. */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  label,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Accessible name; defaults to the placeholder */
  label?: string
  className?: string
}) {
  return (
    <div className={cn("relative w-full min-w-0 sm:max-w-[320px] sm:flex-[1_1_220px]", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-admin-subtle" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="h-8 w-full rounded-md border border-input bg-card pl-8 pr-7 text-[13px] outline-none placeholder:text-admin-subtle focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-admin-subtle hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

export type SegmentOption<V extends string> = { value: V; label: React.ReactNode; count?: number }

/** One-of-many filter tabs, e.g. All / Upcoming / Past / Drafts, with optional counts. */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: SegmentOption<V>[]
  value: V
  onChange: (value: V) => void
  /** Accessible name for the group */
  label: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex max-w-full gap-0.5 overflow-x-auto rounded-[7px] bg-muted p-0.5", className)}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-[5px] px-3 text-[13px] transition-colors",
              active ? "bg-card font-semibold text-foreground shadow-sm" : "font-medium text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
            {option.count !== undefined && <span className="text-xs tabular-nums text-admin-subtle">{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** A dropdown of checkboxes for filtering by several values at once (e.g. status, role). */
export function FilterMenu<V extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: { value: V; label: React.ReactNode }[]
  selected: V[]
  onChange: (selected: V[]) => void
}) {
  const toggle = (value: V) => onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[13px] font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40",
          selected.length ? "border-primary/60" : "border-input",
        )}
      >
        {label}
        {selected.length > 0 && <span className="rounded-full bg-tone-accent px-1.5 text-[11px] font-semibold text-tone-accent-foreground">{selected.length}</span>}
        <ChevronDown className="size-3.5 text-admin-subtle" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className="z-50 min-w-44 rounded-md border bg-popover p-1 text-[13px] shadow-lg">
          {options.map((option) => (
            <DropdownMenu.CheckboxItem
              key={option.value}
              checked={selected.includes(option.value)}
              onCheckedChange={() => toggle(option.value)}
              onSelect={(event) => event.preventDefault()}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-accent"
            >
              <span className="flex size-3.5 items-center justify-center rounded-sm border border-input">
                <DropdownMenu.ItemIndicator>
                  <Check className="size-3" />
                </DropdownMenu.ItemIndicator>
              </span>
              {option.label}
            </DropdownMenu.CheckboxItem>
          ))}
          {selected.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-admin-row" />
              <DropdownMenu.Item onSelect={() => onChange([])} className="cursor-pointer rounded px-2 py-1.5 text-muted-foreground outline-none data-[highlighted]:bg-accent">
                Clear
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The row above a list: search and filters on the left, actions on the right. */
export function Toolbar({ className, children, actions }: { className?: string; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-center gap-2", className)}>
      {children}
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
