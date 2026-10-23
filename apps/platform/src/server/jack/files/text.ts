/**
 * Reading uploaded text files: UTF-8 (with or without a byte-order mark), UTF-16 with a byte-order
 * mark (Excel's "Unicode text"), or Windows-1252 when it isn't valid UTF-8 (older Windows exports).
 * Null for anything binary, so a renamed binary never passes as text.
 */

/** How far into a file to look for NUL bytes, the sign of a binary file */
const BINARY_SNIFF_BYTES = 64 * 1024

export function decodeText(body: Uint8Array): string | null {
  if (body[0] === 0xff && body[1] === 0xfe) return decode("utf-16le", body.subarray(2))
  if (body[0] === 0xfe && body[1] === 0xff) return decode("utf-16be", body.subarray(2))
  const start = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0
  const sniff = body.subarray(start, start + BINARY_SNIFF_BYTES)
  if (sniff.includes(0)) return null
  const text = decode("utf-8", body.subarray(start), true) ?? decode("windows-1252", body.subarray(start))
  return text === null || hasControlNoise(text) ? null : text
}

function decode(encoding: string, bytes: Uint8Array, fatal = false): string | null {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes)
  } catch {
    return null
  }
}

/** Text has tabs and line breaks, not runs of other control characters (a binary file that happens to have no NULs) */
function hasControlNoise(text: string): boolean {
  const sample = text.slice(0, 20_000)
  let controls = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) || code === 0x7f) controls++
  }
  return controls > Math.max(8, sample.length / 100)
}

/** \r\n and \r become \n */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}
