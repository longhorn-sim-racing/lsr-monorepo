import type { Prisma } from "@prisma/client"
import { jackFileUrl } from "@/lib/jack/files"
import type { JackFileItem } from "@/lib/jack/parts"

/** What a room shows for a file; kept apart from the service so message code doesn't load the parsers */
export const jackFileItemSelect = { id: true, filename: true, kind: true, sizeBytes: true, thumbPath: true } satisfies Prisma.JackFileSelect

export type JackFileItemRow = Prisma.JackFileGetPayload<{ select: typeof jackFileItemSelect }>

export function toFileItem(file: JackFileItemRow): JackFileItem {
  return {
    id: file.id,
    filename: file.filename,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    url: jackFileUrl(file.id),
    ...(file.thumbPath ? { thumbUrl: jackFileUrl(file.id, "thumb") } : {}),
  }
}
