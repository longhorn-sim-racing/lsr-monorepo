import { Unzip, UnzipInflate } from "fflate"

/**
 * Looks inside a ZIP (DOCX and XLSX are ZIPs) before any parser opens it: the entry names, and the
 * real uncompressed size, counted while inflating with a cap, so a zip bomb stops at the cap instead
 * of filling memory. The sizes a ZIP declares aren't trusted (they can lie).
 */

export type ZipLimits = { maxEntries: number; maxTotalBytes: number }

/** DOCX and XLSX: 100 MB uncompressed and 5,000 entries is far beyond any real club document */
export const OFFICE_ZIP_LIMITS: ZipLimits = { maxEntries: 5_000, maxTotalBytes: 100_000_000 }

export class ZipLimitError extends Error {
  constructor(readonly reason: "entries" | "size" | "corrupt" | "compression") {
    super(`ZIP refused: ${reason}`)
  }
}

/** Fed in small pieces: inflating 64 KB can make at most about 66 MB, so going over the cap is caught early */
const CHUNK = 64 * 1024

export function inspectZip(data: Uint8Array, limits: ZipLimits = OFFICE_ZIP_LIMITS): { names: string[]; totalBytes: number } {
  const names: string[] = []
  let total = 0
  let problem: ZipLimitError["reason"] | null = null
  const unzip = new Unzip((file) => {
    if (problem) return
    names.push(file.name)
    if (names.length > limits.maxEntries) return void (problem = "entries")
    // Stored (0) and deflate (8) are all Office writes; anything else can't be checked, so it's refused
    if (file.compression !== 0 && file.compression !== 8) return void (problem = "compression")
    file.ondata = (error, chunk) => {
      if (problem) return
      if (error) {
        problem = "corrupt"
        return
      }
      total += chunk.length
      if (total > limits.maxTotalBytes) {
        problem = "size"
        file.terminate()
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    for (let i = 0; i < data.length && !problem; i += CHUNK) unzip.push(data.subarray(i, i + CHUNK), i + CHUNK >= data.length)
  } catch {
    problem ??= "corrupt"
  }
  if (problem) throw new ZipLimitError(problem)
  if (!names.length) throw new ZipLimitError("corrupt")
  return { names, totalBytes: total }
}
