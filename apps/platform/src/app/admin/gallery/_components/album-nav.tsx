"use client"

import type { GalleryAlbum } from "@prisma/client"
import { formatInTimeZone } from "date-fns-tz"
import { FolderPlus } from "lucide-react"
import { IconButton, Panel, Select } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { cn } from "@/lib/utils"

/** Which photos are showing: everything, the unsorted ones, or one album (by id). */
export type GalleryView = "all" | "unsorted" | string

type NavProps = {
  view: GalleryView
  onViewChange: (view: GalleryView) => void
  albums: GalleryAlbum[]
  total: number
  countFor: (albumId: string | null) => number
}

function NavItem({ active, label, detail, count, onClick }: { active: boolean; label: string; detail?: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md border-l-2 px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
        active ? "border-primary bg-admin-selected font-semibold text-foreground" : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {detail && <span className="truncate text-xs font-normal text-admin-subtle">{detail}</span>}
      </span>
      <span className="shrink-0 text-xs font-normal tabular-nums text-admin-subtle">{count}</span>
    </button>
  )
}

export function albumDate(album: GalleryAlbum) {
  return album.date ? formatInTimeZone(album.date, DEFAULT_TIMEZONE, "MMM d, yyyy") : undefined
}

/** The album list beside the photo grid, on wide screens. */
export function AlbumSidebar({ view, onViewChange, albums, total, countFor, onNewAlbum, className }: NavProps & { onNewAlbum: () => void; className?: string }) {
  return (
    <Panel className={cn("flex flex-col overflow-hidden", className)}>
      <nav aria-label="Photos" className="flex flex-col gap-0.5 p-1.5">
        <NavItem active={view === "all"} label="All photos" count={total} onClick={() => onViewChange("all")} />
        <NavItem active={view === "unsorted"} label="Unsorted" count={countFor(null)} onClick={() => onViewChange("unsorted")} />
      </nav>
      <div className="flex items-center justify-between border-t border-admin-row py-1.5 pl-3 pr-1.5">
        <span className="text-xs font-semibold text-muted-foreground">Albums</span>
        <IconButton label="New album" onClick={onNewAlbum}>
          <FolderPlus />
        </IconButton>
      </div>
      <nav aria-label="Albums" className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5">
        {albums.map((album) => (
          <NavItem
            key={album.id}
            active={view === album.id}
            label={album.title}
            detail={albumDate(album)}
            count={countFor(album.id)}
            onClick={() => onViewChange(album.id)}
          />
        ))}
        {albums.length === 0 && <p className="px-2.5 py-2 text-xs text-admin-subtle">No albums yet.</p>}
      </nav>
    </Panel>
  )
}

/** The same choice as a select, for phones. */
export function AlbumSelect({ view, onViewChange, albums, total, countFor, className }: NavProps & { className?: string }) {
  return (
    <Select value={view} onChange={(event) => onViewChange(event.target.value)} aria-label="Album" className={className}>
      <option value="all">All photos ({total})</option>
      <option value="unsorted">Unsorted ({countFor(null)})</option>
      {albums.map((album) => (
        <option key={album.id} value={album.id}>
          {album.title} ({countFor(album.id)})
        </option>
      ))}
    </Select>
  )
}
