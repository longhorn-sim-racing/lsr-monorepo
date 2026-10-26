"use client"

import Link from "next/link"
import { useState, type ReactNode } from "react"
import { Pin } from "lucide-react"
import { Badge, Button, EmptyState, Input, PageHeader, Panel, PanelHeader, RowActions, Segmented } from "@/components/admin/kit"
import { cn } from "@/lib/utils"
import type { JackSpend } from "@/lib/jack/spend"
import { JACK_PERSONA_NAME, jackRoomTitle, type JackRoomSummary } from "@/lib/jack/types"
import { PersonaAvatar } from "./persona-avatar"
import { SpendMeter } from "./spend-meter"

/*
 * The rooms list and the rooms rail beside a room. They render what they're given and report what the
 * officer does; the pages wire up the actions.
 */

const shortTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

export function formatRoomTime(iso: string) {
  return shortTime.format(new Date(iso))
}

/** Which rooms the list shows: the ones in use (pinned first), or the archived ones */
export type RoomListView = "active" | "archived"

type RoomListProps = {
  rooms: JackRoomSummary[]
  /** This month's spend; null if it couldn't be loaded */
  spend: JackSpend | null
  /** Resolves with an error to show, or null once the room is open */
  onCreate: (title: string) => Promise<string | null>
  /** The search box and its results, drawn above the rooms */
  search?: ReactNode
  /** Which rooms these are, and how many are archived (for the switch between the two) */
  view?: RoomListView
  archivedCount?: number
  onView?: (view: RoomListView) => void
  /** Drawn at the end of each room's row (its menu: pin, archive) */
  rowMenu?: (room: JackRoomSummary) => ReactNode
}

export function JackRoomList({ rooms, spend, onCreate, search, view = "active", archivedCount, onView, rowMenu }: RoomListProps) {
  const archived = view === "archived"
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Jack"
        description="Shared rooms for asking Jack about club data. Every officer sees every room, live."
        actions={spend ? <SpendMeter spend={spend} className="text-[13px]" /> : null}
      />
      <NewRoomForm onCreate={onCreate} />
      {search}
      <Panel>
        <PanelHeader
          title={archived ? "Archived rooms" : "Rooms"}
          description={archived ? "Read-only until someone unarchives them · most recently archived first" : "Pinned first, then newest activity"}
          actions={
            onView ? (
              <Segmented
                label="Which rooms"
                value={view}
                onChange={onView}
                options={[
                  { value: "active", label: "In use" },
                  { value: "archived", label: "Archived", count: archivedCount },
                ]}
              />
            ) : null
          }
        />
        {rooms.length ? (
          <ul>
            {rooms.map((room) => (
              <li key={room.id} className="flex items-center border-b border-admin-row last:border-b-0">
                <Link href={`/admin/jack/${room.id}`} className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-admin-surface">
                  <span className="flex min-w-0 items-center gap-3">
                    <PersonaAvatar persona={room.persona} className="size-8" />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {room.pinnedAt && !archived ? <PinnedMark /> : null}
                        <span className="truncate font-semibold">{jackRoomTitle(room)}</span>
                      </span>
                      <span className="text-xs text-admin-subtle">{room.createdByName ? `Opened by ${room.createdByName}` : "Opened by a former officer"}</span>
                    </span>
                  </span>
                  <span className="flex items-center gap-3 text-xs text-admin-subtle">
                    {room.persona === "lift" && <Badge tone="accent">{JACK_PERSONA_NAME.lift}</Badge>}
                    {room.persona === "stand" && <Badge tone="neutral">{JACK_PERSONA_NAME.stand}</Badge>}
                    {archived && room.archivedAt ? `Archived ${formatRoomTime(room.archivedAt)}` : formatRoomTime(room.updatedAt)}
                  </span>
                </Link>
                {rowMenu ? <RowActions className="shrink-0 pr-2">{rowMenu(room)}</RowActions> : null}
              </li>
            ))}
          </ul>
        ) : archived ? (
          <EmptyState title="No archived rooms" description="Archive a room from its menu when the conversation is done; it stays searchable and opens read-only." />
        ) : (
          <EmptyState title="No rooms yet" description="Open one above and ask Jack about events, members, LSC entries or payments." />
        )}
      </Panel>
    </div>
  )
}

/** A small pin before a pinned room's name */
export function PinnedMark({ className }: { className?: string }) {
  return (
    <span title="Pinned" className={cn("inline-flex shrink-0 text-admin-subtle", className)}>
      <Pin aria-hidden className="size-3.5" />
      <span className="sr-only">Pinned: </span>
    </span>
  )
}

function NewRoomForm({ onCreate }: { onCreate: RoomListProps["onCreate"] }) {
  const [title, setTitle] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <form
      className="mb-4 flex flex-wrap items-start gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        if (creating) return
        setCreating(true)
        setError(null)
        const problem = await onCreate(title)
        setCreating(false)
        if (problem) setError(problem)
      }}
    >
      <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
        <label htmlFor="jack-room-title" className="sr-only">
          Room title (optional)
        </label>
        <Input id="jack-room-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="What's this room about? (optional)" />
        {error ? (
          <p role="alert" className="text-xs font-medium text-tone-danger-foreground">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" variant="primary" pending={creating}>
        New room
      </Button>
    </form>
  )
}

/** The rooms column beside an open room, on wide screens: pinned rooms first, like the list. */
export function JackRoomRail({ rooms, activeId }: { rooms: JackRoomSummary[]; activeId: string }) {
  return (
    <nav aria-label="Rooms" className="hidden min-h-0 w-[248px] shrink-0 flex-col gap-2.5 overflow-y-auto border-r bg-admin-surface px-2.5 py-3.5 lg:flex">
      <div className="flex items-center justify-between px-1.5">
        <span className="font-display text-lg font-semibold">Rooms</span>
        <Button asChild size="sm" variant="primary">
          <Link href="/admin/jack">New room</Link>
        </Button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {rooms.map((room) => {
          const active = room.id === activeId
          return (
            <li key={room.id}>
              <Link
                href={`/admin/jack/${room.id}`}
                aria-current={active ? "page" : undefined}
                className={cn("flex flex-col gap-0.5 rounded-md border px-2 py-2", active ? "border-border bg-card" : "border-transparent hover:bg-card")}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1">
                    {room.pinnedAt ? <PinnedMark /> : null}
                    <span className={cn("truncate text-[13px]", active ? "font-bold" : "font-medium")}>{jackRoomTitle(room)}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-admin-subtle">{formatRoomTime(room.updatedAt)}</span>
                </span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <PersonaAvatar persona={room.persona} className="size-4 rounded-sm" />
                  {JACK_PERSONA_NAME[room.persona]} answers
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
