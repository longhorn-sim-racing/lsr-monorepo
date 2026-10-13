"use client"

import * as React from "react"
import * as Popover from "@radix-ui/react-popover"
import { Command } from "cmdk"
import { useDebouncedCallback } from "use-debounce"
import { ChevronsUpDown, Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { searchUsersForAdmin, type AdminUserOption } from "@/server/actions/admin-user-search"

export type { AdminUserOption }

type Search = (query: string) => Promise<AdminUserOption[]>

function UserLine({ user }: { user: AdminUserOption }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-medium">{user.displayName}</span>
      <span className="truncate text-xs text-admin-subtle">
        @{user.handle} · {user.email}
      </span>
    </span>
  )
}

/** The searchable list inside a picker's popover. */
function UserSearchList({ search, onPick, excludeIds = [] }: { search: Search; onPick: (user: AdminUserOption) => void; excludeIds?: string[] }) {
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<AdminUserOption[]>([])
  const [loading, setLoading] = React.useState(false)
  const latest = React.useRef(0)

  const run = useDebouncedCallback(async (q: string) => {
    const ticket = ++latest.current
    try {
      const found = await search(q)
      if (ticket === latest.current) setResults(found)
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, 250)

  const onQuery = (q: string) => {
    setQuery(q)
    if (q.trim().length < 2) {
      latest.current++
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    run(q)
  }

  const shown = results.filter((user) => !excludeIds.includes(user.id))

  return (
    <Command shouldFilter={false} label="Find a member" className="text-[13px]">
      <div className="flex items-center gap-2 border-b px-2.5">
        <Command.Input
          autoFocus
          value={query}
          onValueChange={onQuery}
          placeholder="Name, handle, email or EID"
          className="h-9 flex-1 bg-transparent outline-none placeholder:text-admin-subtle"
        />
        {loading && <Loader2 className="size-3.5 animate-spin text-admin-subtle" aria-hidden />}
      </div>
      <Command.List className="max-h-64 overflow-y-auto p-1">
        {query.trim().length < 2 ? (
          <p className="px-2 py-3 text-xs text-admin-subtle">Type at least 2 characters.</p>
        ) : (
          !loading && shown.length === 0 && <p className="px-2 py-3 text-xs text-admin-subtle">No members match.</p>
        )}
        {shown.map((user) => (
          <Command.Item
            key={user.id}
            value={user.id}
            onSelect={() => onPick(user)}
            className="flex cursor-pointer items-center rounded px-2 py-1.5 data-[selected=true]:bg-accent"
          >
            <UserLine user={user} />
          </Command.Item>
        ))}
      </Command.List>
    </Command>
  )
}

const trigger =
  "flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-card px-2.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"

/** Pick one member by searching. Pass `name` to submit the chosen id with a form. */
export function UserPicker({
  value,
  onChange,
  placeholder = "Choose a member",
  search = searchUsersForAdmin,
  name,
  id,
  disabled,
  className,
}: {
  value: AdminUserOption | null
  onChange: (user: AdminUserOption | null) => void
  placeholder?: string
  search?: Search
  name?: string
  id?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      {name && <input type="hidden" name={name} value={value?.id ?? ""} />}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger id={id} disabled={disabled} className={trigger}>
          <span className={cn("truncate", !value && "text-admin-subtle")}>{value ? `${value.displayName} (@${value.handle})` : placeholder}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-admin-subtle" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={4} className="z-50 w-[min(360px,calc(100vw-2rem))] rounded-md border bg-popover shadow-lg">
            <UserSearchList
              search={search}
              onPick={(user) => {
                onChange(user)
                setOpen(false)
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {value && !disabled && (
        <button type="button" onClick={() => onChange(null)} aria-label="Clear member" className="flex size-7 shrink-0 items-center justify-center rounded-md text-admin-subtle hover:bg-accent hover:text-foreground">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** Pick several members; chosen ones show as removable chips. */
export function UserMultiPicker({
  value,
  onChange,
  placeholder = "Add members",
  search = searchUsersForAdmin,
  disabled,
  className,
}: {
  value: AdminUserOption[]
  onChange: (users: AdminUserOption[]) => void
  placeholder?: string
  search?: Search
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger disabled={disabled} className={trigger}>
          <span className="truncate text-admin-subtle">{placeholder}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-admin-subtle" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={4} className="z-50 w-[min(360px,calc(100vw-2rem))] rounded-md border bg-popover shadow-lg">
            <UserSearchList search={search} excludeIds={value.map((u) => u.id)} onPick={(user) => onChange([...value, user])} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Chosen members">
          {value.map((user) => (
            <li key={user.id} className="flex items-center gap-1 rounded-full border bg-admin-surface py-0.5 pl-2.5 pr-1 text-xs font-medium">
              {user.displayName}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(value.filter((u) => u.id !== user.id))}
                aria-label={`Remove ${user.displayName}`}
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
