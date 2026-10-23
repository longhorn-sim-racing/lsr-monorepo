import { decodeText } from "./text"
import { inspectZip, ZipLimitError, type ZipLimits, OFFICE_ZIP_LIMITS } from "./zip"

/**
 * Checks that an uploaded file's bytes are what its type says (design §5, "magic bytes"). The name and
 * the declared type come from the browser, so neither is trusted: a PNG must start like a PNG, a DOCX
 * must be a ZIP with a Word document inside and no macros, a text file must be text.
 */

export type ContentCheck = { ok: true } | { ok: false; error: string }

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

const LABEL: Record<string, string> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WebP image",
  "application/pdf": "PDF",
  [XLSX]: "Excel spreadsheet",
  [DOCX]: "Word document",
  "text/csv": "CSV file",
  "application/json": "JSON file",
  "text/plain": "text file",
  "text/markdown": "Markdown file",
  "text/vtt": "VTT transcript",
}

/** "an Excel spreadsheet", "a PDF" */
function article(label: string): string {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`
}

/** What the first bytes say a file is, for the error message; null when they say nothing we know */
export function sniff(body: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...body.subarray(start, end))
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "a JPEG"
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "a PNG"
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "a GIF"
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "a WebP image"
  if (ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(ascii(8, 12))) return "an HEIC photo"
  if (ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "an AVIF image"
  if (pdfAt(body) >= 0) return "a PDF"
  if (ascii(0, 4) === "PK\x03\x04") return "a ZIP archive"
  if (ascii(0, 2) === "MZ") return "a Windows program"
  if (ascii(0, 4) === "\x7fELF") return "a program"
  if (body[0] === 0xd0 && body[1] === 0xcf && body[2] === 0x11 && body[3] === 0xe0) return "an old Office file (.doc or .xls)"
  return null
}

/** PDFs may have a little junk before the header; readers accept it within the first 1,024 bytes */
function pdfAt(body: Uint8Array): number {
  return Buffer.from(body.buffer, body.byteOffset, Math.min(body.length, 1024)).indexOf("%PDF-")
}

const IMAGE_SIGNATURE: Record<string, (body: Uint8Array) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => Buffer.from(b.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/gif": (b) => ["GIF87a", "GIF89a"].includes(Buffer.from(b.subarray(0, 6)).toString("latin1")),
  "image/webp": (b) => Buffer.from(b.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(b.subarray(8, 12)).toString("latin1") === "WEBP",
}

/** Inside a DOCX or XLSX: what must be there, and what means macros or the wrong kind of file */
const OFFICE: Record<string, { needs: string; macros: string[]; label: string }> = {
  [DOCX]: { needs: "word/document.xml", macros: ["word/vbaProject.bin"], label: "Word document" },
  [XLSX]: { needs: "xl/workbook.xml", macros: ["xl/vbaProject.bin", "xl/workbook.bin"], label: "Excel spreadsheet" },
}

export function checkContent(contentType: string, body: Uint8Array, zipLimits: ZipLimits = OFFICE_ZIP_LIMITS): ContentCheck {
  const expected = LABEL[contentType] ?? contentType
  const mismatch = (): ContentCheck => {
    const seen = sniff(body)
    if (seen === "an HEIC photo") return { ok: false, error: "This is an HEIC photo, which can't be read yet. Export it as JPEG and attach that." }
    return { ok: false, error: seen ? `This isn't the ${expected} its name says: it looks like ${seen}.` : `This doesn't look like ${article(expected)}. It may be damaged, or saved in another format.` }
  }

  const image = IMAGE_SIGNATURE[contentType]
  if (image) return image(body) ? { ok: true } : mismatch()
  if (contentType === "application/pdf") return pdfAt(body) >= 0 ? { ok: true } : mismatch()

  const office = OFFICE[contentType]
  if (office) {
    if (Buffer.from(body.subarray(0, 4)).toString("latin1") !== "PK\x03\x04") return mismatch()
    let names: string[]
    try {
      names = inspectZip(body, zipLimits).names
    } catch (error) {
      if (error instanceof ZipLimitError && (error.reason === "size" || error.reason === "entries")) return { ok: false, error: `This ${office.label} unpacks to far more than any real document; it can't be attached.` }
      return { ok: false, error: `This ${office.label} is damaged and can't be opened.` }
    }
    if (office.macros.some((name) => names.includes(name))) return { ok: false, error: "This file has macros, which can't be attached. Save it without macros (.xlsx or .docx) and attach that." }
    if (!names.includes(office.needs) || !names.includes("[Content_Types].xml")) return { ok: false, error: `This isn't ${article(office.label)}. Save it again from Word or Excel (or Google Docs/Sheets) and retry.` }
    return { ok: true }
  }

  // Text kinds: text (not a renamed binary), and for JSON and VTT, the right shape
  const text = decodeText(body)
  if (text === null) return mismatch()
  if (contentType === "application/json") {
    try {
      JSON.parse(text)
    } catch {
      return { ok: false, error: "This JSON file isn't valid JSON, so it can't be read." }
    }
  }
  if (contentType === "text/vtt" && !/^WEBVTT(?:[ \t].*)?(?:\r?\n|$)/.test(text.replace(/^﻿/, ""))) {
    return { ok: false, error: "This isn't a VTT transcript (it should start with WEBVTT). Export the transcript as .vtt, or attach it as .txt or .docx." }
  }
  return { ok: true }
}
