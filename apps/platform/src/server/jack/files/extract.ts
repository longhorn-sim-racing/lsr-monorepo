import type { CellValue } from "exceljs"
// pdf.js runs its "worker" in this thread when globalThis.pdfjsWorker is set. Imported statically so
// Vercel's file tracing ships pdf.worker.mjs with the functions that read PDFs (next.config.ts also
// lists it); otherwise pdf.js looks for the file at runtime and fails ("Setting up fake worker failed")
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import type { JackFileKindKey } from "@/lib/jack/parts"
import { decodeText, normalizeNewlines } from "./text"

/**
 * Text from the files officers attach (design §5), for search and for Jack to read: CSV, JSON, text
 * and Markdown, VTT transcripts (with speakers), DOCX (mammoth), XLSX (exceljs, which never evaluates
 * formulas: a formula cell gives the value the spreadsheet saved) and PDF (pdf.js). Everything is
 * capped by characters, rows, pages and time. ZIP-based files were already checked against zip
 * bombs (magic.ts) before they get here.
 *
 * A file whose text can't be read is still a good file (a scanned PDF, a damaged sheet): the result
 * says so in `textStatus` and registration goes on.
 */

/**
 * JackFile.textStatus:
 * - ok: all of it
 * - truncated: cut at a cap (characters, rows or pages)
 * - timeout: stopped at the time limit; `text` has what was read by then
 * - none: there's no text to read (images, a scanned PDF)
 * - failed: the parser couldn't read it
 */
export type TextStatus = "ok" | "truncated" | "timeout" | "none" | "failed"

export type Extraction = { text: string | null; textStatus: TextStatus; pageCount?: number }

export type ExtractLimits = {
  /** Stored text, in characters */
  maxChars: number
  /** CSV lines and spreadsheet rows, across every sheet */
  maxRows: number
  /** One spreadsheet cell */
  maxCellChars: number
  maxPdfPages: number
  timeoutMs: number
}

export const EXTRACT_LIMITS: ExtractLimits = { maxChars: 200_000, maxRows: 5_000, maxCellChars: 500, maxPdfPages: 300, timeoutMs: 25_000 }

export async function extractText(kind: JackFileKindKey, body: Buffer, limits: ExtractLimits = EXTRACT_LIMITS): Promise<Extraction> {
  if (kind === "IMAGE" || kind === "OTHER") return { text: null, textStatus: "none" }
  // Page-by-page readers stop a little before the hard limit, so they keep what they read
  const deadline = Date.now() + limits.timeoutMs * 0.8
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Extraction>((done) => {
    timer = setTimeout(() => done({ text: null, textStatus: "timeout" }), limits.timeoutMs)
  })
  try {
    return await Promise.race([extract(kind, body, limits, deadline), timeout])
  } catch (error) {
    console.warn(`[jack] Couldn't read text from a ${kind} file:`, error instanceof Error ? error.message : error)
    return { text: null, textStatus: "failed" }
  } finally {
    clearTimeout(timer)
  }
}

async function extract(kind: JackFileKindKey, body: Buffer, limits: ExtractLimits, deadline: number): Promise<Extraction> {
  switch (kind) {
    case "PDF":
      return pdfText(body, limits, deadline)
    case "DOCUMENT":
      return docxText(body, limits)
    case "SPREADSHEET":
      return xlsxText(body, limits)
    default: {
      const decoded = decodeText(body)
      if (decoded === null) return { text: null, textStatus: "failed" }
      const text = normalizeNewlines(decoded).replace(/^﻿/, "")
      if (kind === "CSV") return csvText(text, limits)
      if (kind === "JSON") return capped(JSON.stringify(JSON.parse(text), null, 2), limits)
      if (kind === "TRANSCRIPT") return capped(vttText(text), limits)
      return capped(text, limits)
    }
  }
}

/** Cuts at the last line break before the cap when there's one nearby */
export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const cut = text.lastIndexOf("\n", maxChars)
  return { text: text.slice(0, cut > maxChars * 0.9 ? cut : maxChars), truncated: true }
}

function capped(text: string, limits: ExtractLimits, alreadyTruncated = false): Extraction {
  const trimmed = text.trim()
  if (!trimmed) return { text: null, textStatus: "none" }
  const result = capText(trimmed, limits.maxChars)
  return { text: result.text, textStatus: result.truncated || alreadyTruncated ? "truncated" : "ok" }
}

function csvText(text: string, limits: ExtractLimits): Extraction {
  const lines = text.split("\n")
  // The header line plus maxRows rows
  const kept = lines.slice(0, limits.maxRows + 1)
  const more = lines.slice(limits.maxRows + 1).some((line) => line.trim())
  return capped(kept.join("\n"), limits, more)
}

async function pdfText(body: Buffer, limits: ExtractLimits, deadline: number): Promise<Extraction> {
  const scope = globalThis as { pdfjsWorker?: unknown }
  scope.pdfjsWorker ??= pdfjsWorker
  const task = getDocument({ data: new Uint8Array(body), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  try {
    const doc = await task.promise
    const pageCount = doc.numPages
    const pages: string[] = []
    let chars = 0
    let status: TextStatus = "ok"
    for (let n = 1; n <= pageCount; n++) {
      if (n > limits.maxPdfPages || chars >= limits.maxChars) {
        status = "truncated"
        break
      }
      if (Date.now() > deadline) {
        status = "timeout"
        break
      }
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim()
      page.cleanup()
      if (text) {
        pages.push(`--- Page ${n} ---\n${text}`)
        chars += text.length
      }
    }
    // A scanned PDF has pages but no text layer
    if (!pages.length) return { text: null, textStatus: status === "ok" ? "none" : status, pageCount }
    const result = capText(pages.join("\n\n"), limits.maxChars)
    return { text: result.text, textStatus: status === "ok" && result.truncated ? "truncated" : status, pageCount }
  } finally {
    await task.destroy()
  }
}

async function docxText(body: Buffer, limits: ExtractLimits): Promise<Extraction> {
  const mammoth = await import("mammoth")
  const { value } = await (mammoth.default ?? mammoth).extractRawText({ buffer: body })
  return capped(normalizeNewlines(value).replace(/\n{3,}/g, "\n\n"), limits)
}

async function xlsxText(body: Buffer, limits: ExtractLimits): Promise<Extraction> {
  const exceljs = await import("exceljs")
  const ExcelJS = (exceljs as unknown as { default?: typeof exceljs }).default ?? exceljs
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(body as unknown as ArrayBuffer)
  const out: string[] = []
  let rows = 0
  let truncated = false
  for (const sheet of workbook.worksheets) {
    if (rows >= limits.maxRows) {
      truncated = true
      break
    }
    out.push(`## Sheet: ${sheet.name}${sheet.state !== "visible" ? " (hidden)" : ""}`)
    for (let r = 1; r <= sheet.rowCount; r++) {
      if (rows >= limits.maxRows) {
        truncated = true
        break
      }
      const row = sheet.getRow(r)
      if (!row.hasValues) continue
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      out.push(values.map((value) => csvField(cellText(value as CellValue).slice(0, limits.maxCellChars))).join(",").replace(/,+$/, ""))
      rows++
    }
    out.push("")
  }
  return capped(out.join("\n"), limits, truncated)
}

/** A spreadsheet cell as text. Formulas give their saved result (never evaluated), or the formula itself when there's none */
export function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return ""
  if (value instanceof Date) return value.toISOString().replace(/T00:00:00\.000Z$/, "").replace(/\.000Z$/, "Z")
  if (typeof value !== "object") return String(value)
  if ("richText" in value) return value.richText.map((part) => part.text).join("")
  if ("formula" in value || "sharedFormula" in value) {
    const result = (value as { result?: unknown }).result
    if (result !== undefined && result !== null) return cellText(result as CellValue)
    const formula = (value as { formula?: string }).formula
    return formula ? `=${formula}` : ""
  }
  if ("hyperlink" in value) return String(value.text ?? value.hyperlink)
  if ("error" in value) return String(value.error)
  return ""
}

function csvField(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * A VTT transcript as speaker-tagged lines: "[1:23] Dylan Smith: …", one per turn (a speaker's
 * consecutive cues are joined). Speakers come from <v Name> tags (Teams) or a "Name: " prefix (Zoom).
 */
export function vttText(vtt: string): string {
  const turns: { at: string; speaker: string | null; text: string }[] = []
  for (const block of normalizeNewlines(vtt).replace(/^﻿/, "").split(/\n{2,}/)) {
    const lines = block.split("\n")
    const timing = lines.findIndex((line) => line.includes("-->"))
    if (timing < 0) continue // the header, NOTE, STYLE and REGION blocks
    const raw = lines.slice(timing + 1).join(" ").trim()
    if (!raw) continue
    let speaker = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(raw)?.[1]?.trim() || null
    let text = decodeEntities(raw.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim()
    if (!speaker) {
      const prefixed = /^([^:.!?]{1,40}):\s+(.+)$/.exec(text)
      if (prefixed) {
        speaker = prefixed[1].trim()
        text = prefixed[2]
      }
    }
    if (!text) continue
    const last = turns.at(-1)
    if (last && speaker && last.speaker === speaker) last.text += ` ${text}`
    else turns.push({ at: shortTime(lines[timing].split("-->")[0].trim()), speaker, text })
  }
  return turns.map((turn) => `[${turn.at}] ${turn.speaker ? `${turn.speaker}: ` : ""}${turn.text}`).join("\n")
}

/** "00:01:23.456" → "1:23"; "01:02:03.000" → "1:02:03" */
function shortTime(stamp: string): string {
  const parts = stamp.split(".")[0].split(":").map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return stamp
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts]
  const pad = (n: number) => String(n).padStart(2, "0")
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" }

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}
