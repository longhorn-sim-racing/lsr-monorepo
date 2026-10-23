import { isRasterImage } from "@/lib/jack/files"
import { prisma } from "@/server/db"

/**
 * Which stored object a request for a room file gets (GET /api/admin/jack/files/[id]). Files are found
 * by id, never by path, and only READY files are served.
 * - original: the file as uploaded (with its checked type)
 * - model: the copy Jack looks at (photos only: JPEG, no metadata, long edge ≤2000 px)
 * - thumb: the room's small preview (photos only)
 */

export const FILE_VARIANTS = ["original", "model", "thumb"] as const
export type FileVariant = (typeof FILE_VARIANTS)[number]

export type ServableFile = {
  pathname: string
  contentType: string
  /** For Content-Disposition */
  filename: string
  /** Raster images open in the browser; everything else downloads */
  inline: boolean
  /** The original's size; null for the copies, which are always small */
  size: number | null
}

export async function servableFile(id: string, variant: FileVariant): Promise<ServableFile | null> {
  const file = await prisma.jackFile.findUnique({
    where: { id },
    select: { status: true, filename: true, contentType: true, sizeBytes: true, storagePath: true, modelCopyPath: true, thumbPath: true },
  })
  if (!file || file.status !== "READY") return null
  if (variant === "original") {
    return { pathname: file.storagePath, contentType: file.contentType, filename: file.filename, inline: isRasterImage(file.contentType), size: file.sizeBytes }
  }
  const pathname = variant === "model" ? file.modelCopyPath : file.thumbPath
  if (!pathname) return null
  return { pathname, contentType: "image/jpeg", filename: `${file.filename.replace(/\.[^.]+$/, "")}-${variant}.jpg`, inline: true, size: null }
}

/** Content-Disposition with a plain ASCII name and the real one encoded (RFC 6266), so quotes and line breaks in a name can't break the header */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file"
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}
