"use client"

import { useRef, type ClipboardEvent, type DragEvent } from "react"
import { File, FileJson, FileSpreadsheet, FileText, ImageIcon, Paperclip, X, type LucideIcon } from "lucide-react"
import { IconButton } from "@/components/admin/kit"
import { ACCEPT_ATTRIBUTE, MAX_FILES_PER_MESSAGE } from "@/lib/jack/files"
import { formatFileSize, partLink } from "@/lib/jack/links"
import type { JackFileItem, JackFileKindKey } from "@/lib/jack/parts"
import type { JackMessageView } from "@/lib/jack/types"
import type { PendingUpload } from "@/lib/jack/upload-queue"
import { cn } from "@/lib/utils"
import { FilesView } from "./parts/files-view"

/*
 * Files in a room (G5, design §5): the composer's attach button and the chips of files waiting to go,
 * and the attachments under a posted message.
 */

const KIND_ICON: Record<JackFileKindKey, LucideIcon> = {
  IMAGE: ImageIcon,
  PDF: FileText,
  SPREADSHEET: FileSpreadsheet,
  CSV: FileSpreadsheet,
  JSON: FileJson,
  TEXT: FileText,
  DOCUMENT: FileText,
  TRANSCRIPT: FileText,
  OTHER: File,
}

/** The paperclip beside Send: picks files (several at once; on a phone, photos from the library or the camera) */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []))
          // Picking the same file again after removing it should still fire
          e.target.value = ""
        }}
      />
      <IconButton
        label={`Attach files (up to ${MAX_FILES_PER_MESSAGE})`}
        variant="secondary"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="size-8"
      >
        <Paperclip className="size-4" aria-hidden />
      </IconButton>
    </>
  )
}

/** Files pasted into the message box (a screenshot, files copied in a file manager) */
export function filesFromPaste(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
  return Array.from(event.clipboardData?.files ?? [])
}

/** Files dropped on the composer */
export function filesFromDrop(event: DragEvent<HTMLElement>): File[] {
  return Array.from(event.dataTransfer?.files ?? [])
}

/** The files waiting to go with the next message: a preview or icon, name, size or progress, any error, and remove */
export function UploadChips({ items, notice, onRemove }: { items: PendingUpload[]; notice: string | null; onRemove: (key: string) => void }) {
  if (!items.length && !notice) return null
  return (
    <div className="flex flex-col gap-1.5">
      {items.length ? (
        <ul aria-label="Files to send" className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <UploadChip key={item.key} item={item} onRemove={() => onRemove(item.key)} />
          ))}
        </ul>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-tone-warning-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  )
}

function UploadChip({ item, onRemove }: { item: PendingUpload; onRemove: () => void }) {
  const Icon = item.kind ? KIND_ICON[item.kind] : File
  const percent = Math.round(item.progress * 100)
  const failed = item.state === "error"
  return (
    <li
      className={cn(
        "relative flex min-w-0 items-center gap-2 overflow-hidden rounded-md border bg-card py-1 pl-1 pr-0.5",
        failed ? "max-w-full border-tone-danger-foreground/40 bg-tone-danger sm:max-w-sm" : "max-w-[15rem]"
      )}
    >
      {item.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local preview (object URL) of the photo being attached
        <img src={item.previewUrl} alt="" aria-hidden className="size-8 shrink-0 rounded object-cover" />
      ) : (
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded bg-admin-surface text-admin-subtle">
          <Icon className="size-4" />
        </span>
      )}
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-medium" title={item.name}>
          {item.name}
        </span>
        {failed ? (
          <span role="alert" className="text-[11px] text-tone-danger-foreground">
            {item.error}
          </span>
        ) : (
          <span className="text-[11px] text-admin-subtle tabular-nums">
            {item.state === "uploading" ? `${percent}% of ${formatFileSize(item.size)}` : item.state === "checking" ? "Checking…" : formatFileSize(item.size)}
          </span>
        )}
      </span>
      <IconButton label={`Remove ${item.name}`} onClick={onRemove} className="size-6 shrink-0 self-start">
        <X className="size-3.5" aria-hidden />
      </IconButton>
      {item.state === "uploading" ? (
        <span
          role="progressbar"
          aria-label={`Uploading ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-admin-row"
        >
          <span className="block h-full bg-primary transition-[width] duration-200" style={{ width: `${percent}%` }} />
        </span>
      ) : null}
    </li>
  )
}

/**
 * A posted message's attachments: photos as thumbnails, other files as tiles (FilesView). A click
 * opens the file through the officer-only file route. A module-level function, so the room's
 * memoized message rows get the same one every render.
 */
export function renderMessageFiles(message: JackMessageView) {
  return message.files?.length ? <MessageFiles files={message.files} /> : null
}

function MessageFiles({ files }: { files: JackFileItem[] }) {
  const photos = files.filter((file) => file.kind === "IMAGE" && file.thumbUrl && partLink(file.thumbUrl)?.internal && partLink(file.url)?.internal)
  const others = files.filter((file) => !photos.includes(file))
  return (
    <div className="flex flex-col gap-2">
      {photos.length ? (
        <ul aria-label="Photos" className="flex flex-wrap gap-2">
          {photos.map((file) => (
            <li key={file.id}>
              <a
                href={partLink(file.url)!.href}
                target="_blank"
                rel="noreferrer"
                title={`${file.filename} (${formatFileSize(file.sizeBytes)})`}
                className="block overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- an officer-only route serves it; next/image can't pass the session */}
                <img src={partLink(file.thumbUrl!)!.href} alt={file.filename} loading="lazy" className="size-28 object-cover sm:size-32" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {others.length ? <FilesView files={others} /> : null}
    </div>
  )
}
