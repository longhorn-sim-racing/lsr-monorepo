"use client"

import Image from "next/image"
import type { GalleryAlbum, GalleryImage } from "@prisma/client"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, Pencil, Trash2 } from "lucide-react"
import { IconButton, Select } from "@/components/admin/kit"
import { cloudinaryUrl } from "@/lib/cloudinary"
import { cn } from "@/lib/utils"

type CardProps = {
  image: GalleryImage
  /** Position in the album, shown when the order means something */
  position?: number
  albums: GalleryAlbum[]
  busy?: boolean
  onMove?: (image: GalleryImage, albumId: string | null) => void
  onEditCredit?: (image: GalleryImage) => void
  onDelete?: (image: GalleryImage) => void
}

/** One photo: thumbnail, album picker, credit and actions. `handle` is the drag handle, when sortable. */
export function GalleryCard({
  image,
  position,
  albums,
  busy,
  onMove,
  onEditCredit,
  onDelete,
  handle,
  overlay = false,
}: CardProps & { handle?: React.ReactNode; overlay?: boolean }) {
  return (
    <div className={cn("flex h-full flex-col overflow-hidden rounded-lg border bg-card", overlay && "cursor-grabbing border-primary shadow-xl")}>
      <div className="relative aspect-video w-full bg-admin-surface">
        <Image
          src={cloudinaryUrl(image.publicId, { width: 400, height: 300, crop: "fill" })}
          alt={image.alt ?? image.creditName ?? "Gallery photo"}
          fill
          unoptimized
          sizes="(min-width: 1280px) 20vw, (min-width: 768px) 30vw, 50vw"
          className="pointer-events-none object-cover"
        />
        {position !== undefined && (
          <span className="pointer-events-none absolute left-1.5 top-1.5 rounded border bg-card px-1.5 text-[11px] font-semibold tabular-nums text-foreground">
            #{position}
          </span>
        )}
        {handle}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-admin-row p-2">
        {onMove && (
          <Select
            value={image.albumId ?? ""}
            onChange={(event) => onMove(image, event.target.value || null)}
            disabled={busy}
            aria-label="Album"
            className="h-7 text-xs"
          >
            <option value="">Unsorted</option>
            {albums.map((album) => (
              <option key={album.id} value={album.id}>
                {album.title}
              </option>
            ))}
          </Select>
        )}
        <div className="flex min-w-0 items-center justify-between gap-1">
          <span className={cn("min-w-0 truncate text-xs", image.creditName ? "text-muted-foreground" : "text-admin-subtle")}>
            {image.creditName ? `© ${image.creditName}` : "No credit"}
          </span>
          {(onEditCredit || onDelete) && (
            <span className="-mr-1 flex shrink-0 items-center">
              {onEditCredit && (
                <IconButton label="Edit credit" onClick={() => onEditCredit(image)} disabled={busy}>
                  <Pencil />
                </IconButton>
              )}
              {onDelete && (
                <IconButton label="Delete photo" onClick={() => onDelete(image)} disabled={busy} className="hover:bg-tone-danger hover:text-tone-danger-foreground">
                  <Trash2 />
                </IconButton>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** A card in the sortable grid. Only the handle starts a drag, so the page still scrolls on touch screens. */
export function SortableGalleryCard({ sortable, ...props }: CardProps & { sortable: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: props.image.id,
    disabled: !sortable,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 }}
      className="relative min-w-0"
    >
      <GalleryCard
        {...props}
        handle={
          sortable && (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label="Drag to reorder"
              title="Drag to reorder"
              className="absolute right-1.5 top-1.5 flex size-7 cursor-grab touch-none items-center justify-center rounded-md border bg-card text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 active:cursor-grabbing"
            >
              <GripVertical className="size-4" />
            </button>
          )
        }
      />
    </div>
  )
}
