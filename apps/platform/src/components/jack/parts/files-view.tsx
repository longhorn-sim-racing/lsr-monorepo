import { File, FileJson, FileSpreadsheet, FileText, ImageIcon, type LucideIcon } from "lucide-react"
import { formatFileSize, partLink } from "@/lib/jack/links"
import type { JackFileItem, JackFileKindKey } from "@/lib/jack/parts"
import { PartLink } from "./part-link"

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

/**
 * Files in a room (#188, design §5): an image's thumbnail or an icon for its kind, the name and size,
 * each opening in a new tab through the officer-only file route. Used for a `files` part and, by
 * default, for the files attached to an officer's message.
 */
export function FilesView({ files }: { files: JackFileItem[] }) {
  if (!files.length) return null
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
      {files.map((file) => (
        <li key={file.id} className="flex min-w-0 items-center gap-2.5 rounded-lg border bg-card p-2">
          <FileThumb file={file} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px]" title={file.filename}>
              <PartLink url={file.url} file>
                {file.filename}
              </PartLink>
            </span>
            <span className="text-xs text-admin-subtle tabular-nums">{formatFileSize(file.sizeBytes)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function FileThumb({ file }: { file: JackFileItem }) {
  const thumb = file.thumbUrl ? partLink(file.thumbUrl) : null
  if (thumb)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- an officer-only route serves it; next/image can't pass the session
      <img src={thumb.href} alt="" aria-hidden loading="lazy" className="size-10 shrink-0 rounded-md border bg-muted object-cover" />
    )
  const Icon = KIND_ICON[file.kind] ?? File
  return (
    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-md bg-admin-surface text-admin-subtle">
      <Icon className="size-4" />
    </span>
  )
}
