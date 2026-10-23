import type { JackFileItem, JackFileKindKey } from "./parts"

/**
 * Which files officers can attach in a room, and how they're named (#188, design §5). Pure, so the
 * composer can refuse a file before uploading it and the server checks the same rules again.
 */

/** Largest file an officer can attach. Supabase Free allows 50 MB per file; this leaves room for the parsers */
export const MAX_FILE_BYTES = 25_000_000
export const MAX_FILES_PER_MESSAGE = 10

/** Where a room file is served (officers only), by id, never by path */
export function jackFileUrl(id: string, variant?: "thumb" | "model"): string {
  return `/api/admin/jack/files/${id}${variant ? `?variant=${variant}` : ""}`
}

type AllowedType = {
  kind: JackFileKindKey
  /** What it's stored and served as */
  contentType: string
  /** Other types browsers and operating systems report for it */
  aliases?: string[]
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** By file extension. HEIC isn't here: the installed sharp can't read it (see REFUSED) */
const ALLOWED: Record<string, AllowedType> = {
  jpg: { kind: "IMAGE", contentType: "image/jpeg", aliases: ["image/jpg", "image/pjpeg"] },
  jpeg: { kind: "IMAGE", contentType: "image/jpeg", aliases: ["image/jpg", "image/pjpeg"] },
  png: { kind: "IMAGE", contentType: "image/png" },
  webp: { kind: "IMAGE", contentType: "image/webp" },
  gif: { kind: "IMAGE", contentType: "image/gif" },
  pdf: { kind: "PDF", contentType: "application/pdf", aliases: ["application/x-pdf"] },
  csv: { kind: "CSV", contentType: "text/csv", aliases: ["application/vnd.ms-excel", "application/csv", "text/x-csv", "text/comma-separated-values", "text/plain"] },
  xlsx: { kind: "SPREADSHEET", contentType: XLSX },
  json: { kind: "JSON", contentType: "application/json", aliases: ["text/json", "text/plain"] },
  txt: { kind: "TEXT", contentType: "text/plain" },
  md: { kind: "TEXT", contentType: "text/markdown", aliases: ["text/x-markdown", "text/plain"] },
  markdown: { kind: "TEXT", contentType: "text/markdown", aliases: ["text/x-markdown", "text/plain"] },
  vtt: { kind: "TRANSCRIPT", contentType: "text/vtt", aliases: ["text/plain"] },
  docx: { kind: "DOCUMENT", contentType: DOCX },
}

/** What a browser reports when it can't tell; the extension decides */
const UNKNOWN_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"])

const SCRIPTS = "Programs and scripts can't be attached."
const MACROS = "Files with macros can't be attached. Save it as .xlsx or .docx without macros."
const ARCHIVES = "Archives (.zip and the like) can't be attached. Attach the files inside instead."
const MARKUP = "Web pages, SVG and XML files can't be attached: they can carry scripts. Export it as PDF or text."
const HEIC = "HEIC photos can't be read yet. Export it as JPEG (on an iPhone: share it and pick JPEG, or set Camera → Formats → Most Compatible)."

/** Refused on purpose, with the reason (design §5) */
const REFUSED: Record<string, string> = {
  ...Object.fromEntries(["svg", "svgz", "html", "htm", "xhtml", "xht", "shtml", "mht", "mhtml", "xml", "xsl", "xslt"].map((ext) => [ext, MARKUP])),
  ...Object.fromEntries(["xlsm", "xltm", "xlam", "xlsb", "docm", "dotm", "pptm", "potm", "ppsm", "ppam"].map((ext) => [ext, MACROS])),
  ...Object.fromEntries(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab", "iso", "lz", "lzma"].map((ext) => [ext, ARCHIVES])),
  ...Object.fromEntries(
    ["exe", "dll", "msi", "msix", "appx", "bat", "cmd", "com", "scr", "cpl", "ps1", "psm1", "vbs", "vbe", "js", "mjs", "cjs", "jse", "wsf", "wsh", "hta", "jar", "apk", "app", "dmg", "pkg", "sh", "bash", "zsh", "lnk", "reg", "py"].map((ext) => [ext, SCRIPTS]),
  ),
  heic: HEIC,
  heif: HEIC,
}

/** Declared types refused whatever the name says */
const REFUSED_TYPES: Record<string, string> = {
  "image/svg+xml": MARKUP,
  "text/html": MARKUP,
  "application/xhtml+xml": MARKUP,
  "application/xml": MARKUP,
  "text/xml": MARKUP,
  "application/zip": ARCHIVES,
  "application/x-zip-compressed": ARCHIVES,
  "application/x-7z-compressed": ARCHIVES,
  "application/x-rar-compressed": ARCHIVES,
  "application/vnd.rar": ARCHIVES,
  "application/gzip": ARCHIVES,
  "application/x-tar": ARCHIVES,
  "application/x-msdownload": SCRIPTS,
  "application/x-msdos-program": SCRIPTS,
  "application/x-sh": SCRIPTS,
  "application/javascript": SCRIPTS,
  "text/javascript": SCRIPTS,
  "application/vnd.ms-excel.sheet.macroenabled.12": MACROS,
  "application/vnd.ms-word.document.macroenabled.12": MACROS,
  "image/heic": HEIC,
  "image/heif": HEIC,
}

const ALLOWED_LIST = "photos (JPEG, PNG, WebP, GIF), PDFs, spreadsheets (CSV, XLSX), JSON, text and Markdown, transcripts (VTT) and Word documents (DOCX)"

/** For the file picker */
export const ACCEPT_ATTRIBUTE = [...Object.keys(ALLOWED).map((ext) => `.${ext}`), ...new Set(Object.values(ALLOWED).map((t) => t.contentType))].join(",")

/** The extension, lowercased, or "" when the name has none */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ""
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

/** "text/csv; charset=utf-8" → "text/csv" */
export function baseContentType(type: string | null | undefined): string {
  return (type ?? "").split(";")[0].trim().toLowerCase()
}

/*
 * Characters that change how a name reads without being visible: C0/C1 controls, DEL, and the
 * bidirectional overrides that make "photo‮gpj.exe" show as "photoexe.jpg"
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g

/** The name officers see: no folders, no invisible characters, at most 200 characters (the extension kept) */
export function cleanDisplayName(name: string): string {
  const base = (name.normalize("NFC").split(/[\\/]/).pop() ?? "").replace(/[\t\n\r\f\v]+/g, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim()
  if (base.length <= 200) return base || "file"
  const ext = fileExtension(base)
  return ext && ext.length < 20 ? `${base.slice(0, 199 - ext.length).trimEnd()}.${ext}` : base.slice(0, 200)
}

/**
 * The name in the storage path: ASCII letters, digits, dots, dashes and underscores only, at most 80
 * characters before the extension, never starting with a dot. Accents are dropped ("Café" → "Cafe")
 */
export function storageName(name: string, ext = fileExtension(name)): string {
  const display = cleanDisplayName(name)
  const stem = ext && display.toLowerCase().endsWith(`.${ext}`) ? display.slice(0, -(ext.length + 1)) : display
  const safe =
    stem
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 80)
      .replace(/[-._]+$/, "") || "file"
  const safeExt = ext.replace(/[^a-z0-9]/g, "")
  return safeExt ? `${safe}.${safeExt}` : safe
}

export type FileCheck =
  | { ok: true; ext: string; kind: JackFileKindKey; contentType: string; filename: string; storageName: string }
  | { ok: false; error: string }

/**
 * Whether a file can be attached, from its name, declared type and size, and what it's stored as.
 * The extension decides the type; a declared type that says something else is refused. The server
 * checks the bytes again after the upload (magic bytes, design §5).
 */
export function checkFile({ name, type, size }: { name: string; type?: string | null; size: number }): FileCheck {
  const filename = cleanDisplayName(name)
  const ext = fileExtension(filename)
  const declared = baseContentType(type)
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "This file is empty." }
  if (size > MAX_FILE_BYTES) return { ok: false, error: `This file is ${megabytes(size)}; the limit is ${megabytes(MAX_FILE_BYTES)}.` }
  const refused = REFUSED[ext] ?? REFUSED_TYPES[declared]
  if (refused) return { ok: false, error: refused }
  if (!ext) return { ok: false, error: `This file has no extension, so Jack can't tell what it is. He takes ${ALLOWED_LIST}.` }
  const allowed = ALLOWED[ext]
  if (!allowed) return { ok: false, error: `Jack can't take .${ext} files. He takes ${ALLOWED_LIST}.` }
  if (!UNKNOWN_TYPES.has(declared) && declared !== allowed.contentType && !allowed.aliases?.includes(declared)) {
    return { ok: false, error: `This file says it's ${declared}, which doesn't match .${ext}. Save it again as .${ext} and retry.` }
  }
  return { ok: true, ext, kind: allowed.kind, contentType: allowed.contentType, filename, storageName: storageName(filename, ext) }
}

/** Every content type the store takes for room files (the bucket's allow-list adds the deck files) */
export const ROOM_FILE_CONTENT_TYPES = [...new Set(Object.values(ALLOWED).map((t) => t.contentType))]

/** Raster images open in the browser; everything else downloads */
export function isRasterImage(contentType: string): boolean {
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(baseContentType(contentType))
}

function megabytes(bytes: number) {
  const mb = bytes / 1_000_000
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`
}

/** What createJackUpload hands the browser: the new file's id and where to send its bytes */
export type JackUploadTicket = {
  file: Pick<JackFileItem, "id" | "filename" | "kind" | "sizeBytes">
  /** A signed upload URL (Supabase Storage) or the local upload route (the files store in development) */
  url: string
  /** The type to upload it as (what the server checks it against) */
  contentType: string
}

/** What registering an upload answers (POST /api/admin/jack/files/[id]/register) */
export type JackRegisterResult = { ok: true; file: JackFileItem } | { ok: false; error: string }
