import { Inflate, zipSync } from "fflate"

/**
 * Reads the ZIPs inside DOCX and XLSX files before any parser sees them (design §5).
 *
 * Entries are read the way Word, Excel and JSZip read them: from the central directory at the end of
 * the file, each checked against its local header. An archive whose two views could disagree is
 * refused: entries that overlap or share data, gaps between them, a central directory that names a
 * different file than the header it points at. So the names checked (macros) and the bytes counted
 * are what any reader would see.
 *
 * Sizes are counted while inflating, a small piece at a time, so a zip bomb stops at the cap instead
 * of filling memory; the sizes a ZIP declares aren't trusted.
 *
 * - inspectZip: every entry's name and the real uncompressed total (the upload check, magic.ts)
 * - readZipParts and packZip: only the parts a parser reads, each capped, packed into a fresh archive.
 *   mammoth and exceljs only ever open that archive (extract.ts), never the upload itself.
 */

export type ZipLimits = { maxEntries: number; maxTotalBytes: number }

/** DOCX and XLSX: 100 MB uncompressed and 5,000 entries is far beyond any real club document */
export const OFFICE_ZIP_LIMITS: ZipLimits = { maxEntries: 5_000, maxTotalBytes: 100_000_000 }

export class ZipLimitError extends Error {
  constructor(readonly reason: "entries" | "size" | "corrupt" | "compression" | "layout") {
    super(`ZIP refused: ${reason}`)
  }
}

type Entry = { name: string; method: number; dataStart: number; compressedSize: number }

const SIG = { end: 0x06054b50, end64: 0x06064b50, locator64: 0x07064b50, central: 0x02014b50, local: 0x04034b50 }

/** Inflated a small piece at a time: 16 KB of deflate makes at most about 17 MB, so a cap is caught early */
const STEP = 16 * 1024

/**
 * The entries as the central directory lists them, checked against the local headers: they tile the
 * file from its first byte to the central directory, in order, each header naming the same file with
 * the same method (and size, unless a data descriptor follows the data)
 */
function readEntries(data: Uint8Array, maxEntries: number): Entry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const u16 = (at: number) => view.getUint16(at, true)
  const u32 = (at: number) => view.getUint32(at, true)
  const u64 = (at: number) => Number(view.getBigUint64(at, true))

  // The end record: the last one in the final 64 KB (a comment may follow it), as JSZip finds it
  let end = -1
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at--) {
    if (u32(at) === SIG.end) {
      end = at
      break
    }
  }
  if (end < 0) throw new ZipLimitError("corrupt")
  let count = u16(end + 10)
  let centralSize = u32(end + 12)
  let centralStart = u32(end + 16)
  let centralEnd = end
  if (count === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff) {
    // ZIP64: the real numbers are in a record the locator points at
    if (end < 20 || u32(end - 20) !== SIG.locator64) throw new ZipLimitError("corrupt")
    const record = u64(end - 12)
    if (record + 56 > end - 20 || u32(record) !== SIG.end64) throw new ZipLimitError("corrupt")
    count = u64(record + 32)
    centralSize = u64(record + 40)
    centralStart = u64(record + 48)
    centralEnd = record
  }
  if (count > maxEntries) throw new ZipLimitError("entries")
  if (!count || centralStart + centralSize > centralEnd) throw new ZipLimitError("corrupt")

  const entries: (Entry & { offset: number; nameBytes: Uint8Array; descriptor: boolean })[] = []
  const names = new Set<string>()
  let at = centralStart
  for (let i = 0; i < count; i++) {
    if (u32(at) !== SIG.central) throw new ZipLimitError("corrupt")
    const flags = u16(at + 8)
    const method = u16(at + 10)
    let compressedSize = u32(at + 20)
    const size = u32(at + 24)
    const nameLength = u16(at + 28)
    const extraLength = u16(at + 30)
    const commentLength = u16(at + 32)
    let offset = u32(at + 42)
    const nameBytes = data.subarray(at + 46, at + 46 + nameLength)
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      // The ZIP64 extra field holds, in order, whichever of these were too big for 32 bits
      const zip64 = findExtra(view, at + 46 + nameLength, extraLength, 0x0001)
      if (!zip64) throw new ZipLimitError("corrupt")
      let field = zip64.start
      if (size === 0xffffffff) field += 8
      if (compressedSize === 0xffffffff) {
        compressedSize = u64(field)
        field += 8
      }
      if (offset === 0xffffffff) offset = u64(field)
    }
    // Encrypted entries can't be checked
    if (flags & 1) throw new ZipLimitError("compression")
    // Stored (0) and deflate (8) are all Office writes; anything else can't be checked
    if (method !== 0 && method !== 8) throw new ZipLimitError("compression")
    const name = Buffer.from(nameBytes).toString(flags & 0x800 ? "utf8" : "latin1")
    if (names.has(name)) throw new ZipLimitError("layout")
    names.add(name)
    entries.push({ name, method, compressedSize, offset, nameBytes, descriptor: false, dataStart: 0 })
    at += 46 + nameLength + extraLength + commentLength
  }
  if (at > centralStart + centralSize) throw new ZipLimitError("corrupt")

  // Each local header where its central record says, with nothing between, beside or inside them
  const byOffset = [...entries].sort((a, b) => a.offset - b.offset)
  let next = 0
  for (const [i, entry] of byOffset.entries()) {
    if (entry.offset !== next || u32(entry.offset) !== SIG.local) throw new ZipLimitError("layout")
    const localFlags = u16(entry.offset + 6)
    const localMethod = u16(entry.offset + 8)
    const localSize = u32(entry.offset + 18)
    const nameLength = u16(entry.offset + 26)
    const extraLength = u16(entry.offset + 28)
    const localName = data.subarray(entry.offset + 30, entry.offset + 30 + nameLength)
    if (localMethod !== entry.method || !Buffer.from(localName).equals(Buffer.from(entry.nameBytes))) throw new ZipLimitError("layout")
    entry.descriptor = Boolean(localFlags & 8)
    if (!entry.descriptor && localSize !== 0xffffffff && localSize !== entry.compressedSize) throw new ZipLimitError("layout")
    entry.dataStart = entry.offset + 30 + nameLength + extraLength
    const dataEnd = entry.dataStart + entry.compressedSize
    const following = byOffset[i + 1]?.offset ?? centralStart
    // A data descriptor (12 to 24 bytes) may sit between an entry's data and the next header
    const gap = following - dataEnd
    if (entry.descriptor ? ![12, 16, 20, 24].includes(gap) : gap !== 0) throw new ZipLimitError("layout")
    next = following
  }
  return entries.map(({ name, method, dataStart, compressedSize }) => ({ name, method, dataStart, compressedSize }))
}

function findExtra(view: DataView, start: number, length: number, id: number): { start: number } | null {
  for (let at = start; at + 4 <= start + length; ) {
    const size = view.getUint16(at + 2, true)
    if (view.getUint16(at, true) === id) return { start: at + 4 }
    at += 4 + size
  }
  return null
}

/** Inflates one entry a piece at a time, handing each piece to `take`, which returns false to stop early */
function inflateEntry(data: Uint8Array, entry: Entry, take: (piece: Uint8Array) => boolean): void {
  const raw = data.subarray(entry.dataStart, entry.dataStart + entry.compressedSize)
  if (entry.method === 0) {
    for (let i = 0; i < raw.length; i += STEP) if (!take(raw.subarray(i, i + STEP))) return
    return
  }
  let stopped = false
  const inflate = new Inflate((piece) => {
    if (!stopped && !take(piece)) stopped = true
  })
  for (let i = 0; i < raw.length && !stopped; i += STEP) inflate.push(raw.subarray(i, i + STEP), i + STEP >= raw.length)
}

/** Runs a read, turning anything that isn't already a ZipLimitError (bad offsets, bad deflate data) into "corrupt" */
function guarded<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    throw error instanceof ZipLimitError ? error : new ZipLimitError("corrupt")
  }
}

/** Every entry's name and the real uncompressed total; throws ZipLimitError over the limits or when the archive can't be trusted */
export function inspectZip(data: Uint8Array, limits: ZipLimits = OFFICE_ZIP_LIMITS): { names: string[]; totalBytes: number } {
  return guarded(() => {
    const entries = readEntries(data, limits.maxEntries)
    let total = 0
    for (const entry of entries) {
      inflateEntry(data, entry, (piece) => {
        total += piece.length
        if (total > limits.maxTotalBytes) throw new ZipLimitError("size")
        return true
      })
    }
    return { names: entries.map((entry) => entry.name), totalBytes: total }
  })
}

/** A part a parser reads; `cut` when only its first bytes were kept */
export type ZipPart = { name: string; data: Uint8Array; cut: boolean }

/**
 * Which parts a parser reads, and how much of each to keep: `pick` names a part's group and its own
 * cap; each group has a total budget (`budgets`). Entries not picked are never inflated.
 */
export type PartPlan = { pick(name: string): { group: string; max: number } | null; budgets: Readonly<Record<string, number>> }

/**
 * The picked parts, inflated up to their caps (a part over its cap keeps its first bytes, `cut`). `left`
 * names picked parts that didn't fit their group's budget at all.
 */
export function readZipParts(data: Uint8Array, plan: PartPlan, limits: Pick<ZipLimits, "maxEntries"> = OFFICE_ZIP_LIMITS): { parts: ZipPart[]; left: string[] } {
  return guarded(() => {
    const used: Record<string, number> = {}
    const parts: ZipPart[] = []
    const left: string[] = []
    for (const entry of readEntries(data, limits.maxEntries)) {
      const pick = plan.pick(entry.name)
      if (!pick) continue
      const room = Math.min(pick.max, (plan.budgets[pick.group] ?? 0) - (used[pick.group] ?? 0))
      if (room <= 0) {
        left.push(entry.name)
        continue
      }
      const pieces: Uint8Array[] = []
      let size = 0
      let cut = false
      inflateEntry(data, entry, (piece) => {
        const keep = Math.min(piece.length, room - size)
        if (keep > 0) pieces.push(keep < piece.length ? piece.subarray(0, keep) : piece)
        size += keep
        if (keep < piece.length) cut = true
        return !cut
      })
      used[pick.group] = (used[pick.group] ?? 0) + size
      parts.push({ name: entry.name, data: concat(pieces, size), cut })
    }
    return { parts, left }
  })
}

/** A fresh archive of these parts, in this order, stored (not compressed): what the parsers open */
export function packZip(parts: { name: string; data: Uint8Array }[]): Uint8Array {
  return zipSync(Object.fromEntries(parts.map((part) => [part.name, part.data])), { level: 0 })
}

function concat(pieces: Uint8Array[], size: number): Uint8Array {
  if (pieces.length === 1 && pieces[0].length === size) return pieces[0]
  const out = new Uint8Array(size)
  let at = 0
  for (const piece of pieces) {
    out.set(piece, at)
    at += piece.length
  }
  return out
}
