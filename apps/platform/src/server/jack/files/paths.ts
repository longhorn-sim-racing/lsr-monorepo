/**
 * Where a room file's bytes live in the store. The server picks every path; nothing a browser sends
 * becomes part of one except the sanitized file name (lib/jack/files.ts storageName).
 */

/** The original, exactly where its signed upload URL points */
export function roomFilePath(roomId: string, fileId: string, storageName: string): string {
  return `rooms/${roomId}/${fileId}/${storageName}`
}

/** The copies made at registration. A sanitized name has no slash, so they can't collide with the original */
export function derivedFilePath(file: { roomId: string; id: string }, which: "model" | "thumb"): string {
  return `rooms/${file.roomId}/${file.id}/derived/${which}.jpg`
}

/** The stored objects a file's row records */
export function storedPaths(file: { storagePath: string; modelCopyPath: string | null; thumbPath: string | null }): string[] {
  return [file.storagePath, file.modelCopyPath, file.thumbPath].filter((p): p is string => Boolean(p))
}

/**
 * Every path a file's bytes can be at, recorded or not: registration stores the photo copies before
 * it records them, so deleting a file deletes these, never only what its row says
 */
export function filePaths(file: { roomId: string; id: string; storagePath: string }): string[] {
  return [file.storagePath, derivedFilePath(file, "model"), derivedFilePath(file, "thumb")]
}

/** The file id in a room file's path (rooms/<roomId>/<fileId>/…), or null for anything else */
export function fileIdOfPath(pathname: string): string | null {
  return /^rooms\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i.exec(pathname)?.[1] ?? null
}
