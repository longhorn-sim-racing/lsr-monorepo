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

/** Every stored object of a file */
export function storedPaths(file: { storagePath: string; modelCopyPath: string | null; thumbPath: string | null }): string[] {
  return [file.storagePath, file.modelCopyPath, file.thumbPath].filter((p): p is string => Boolean(p))
}
