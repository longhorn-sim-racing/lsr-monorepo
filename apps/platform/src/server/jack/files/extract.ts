import { Readable } from "node:stream"
import type { CellValue } from "exceljs"
// pdf.js runs its "worker" in this thread when globalThis.pdfjsWorker is set. Imported statically so
// Vercel's file tracing ships pdf.worker.mjs with the functions that read PDFs (next.config.ts also
// lists it); otherwise pdf.js looks for the file at runtime and fails ("Setting up fake worker failed")
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import type { JackFileKindKey } from "@/lib/jack/parts"
import { decodeText, normalizeNewlines } from "./text"
import { packZip, readZipParts, type PartPlan, type ZipPart } from "./zip"

/**
 * Text from the files officers attach (design §5), for search and for Jack to read: CSV, JSON, text
 * and Markdown, VTT transcripts (with speakers), DOCX (mammoth), XLSX (exceljs, which never evaluates
 * formulas: a formula cell gives the value the spreadsheet saved) and PDF (pdf.js). Everything is
 * capped by characters, rows, pages, bytes and time.
 *
 * Memory: a parser never gets the uploaded DOCX or XLSX. zip.ts takes out only the parts it reads,
 * each capped (`maxXmlBytes`), and packs them into a fresh archive. Spreadsheets are streamed row by
 * row and stop at the row cap. mammoth builds the whole document in memory (about 60 times the XML),
 * so it only gets documents up to `maxMammothBytes`; bigger ones are read straight from their XML.
 *
 * Time: at the limit the readers stop themselves (PDFs between pages, spreadsheets between rows) and
 * keep what they read. A Word document's parse can't be stopped midway, so its input is kept small.
 *
 * A file whose text can't be read is still a good file (a scanned PDF, a damaged sheet): the result
 * says so in `textStatus` and registration goes on.
 */

/**
 * JackFile.textStatus:
 * - ok: all of it
 * - truncated: cut at a cap (characters, rows, pages or bytes)
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
  /**
   * XML read from inside a DOCX or XLSX: each of the sheets together, the shared strings, and a Word
   * document read without mammoth. Past it only the start is read (truncated)
   */
  maxXmlBytes: number
  /** The largest Word document (its XML, notes included) mammoth gets; bigger ones are read straight from the XML */
  maxMammothBytes: number
  timeoutMs: number
}

export const EXTRACT_LIMITS: ExtractLimits = {
  maxChars: 200_000,
  maxRows: 5_000,
  maxCellChars: 500,
  maxPdfPages: 300,
  maxXmlBytes: 16_000_000,
  maxMammothBytes: 2_000_000,
  timeoutMs: 25_000,
}

/** When the readers wrap up (`deadline`, keeping what they read) and when they must quit (`signal`, at the hard limit) */
type Stop = { deadline: number; signal: AbortSignal }

export async function extractText(kind: JackFileKindKey, body: Buffer, limits: ExtractLimits = EXTRACT_LIMITS): Promise<Extraction> {
  if (kind === "IMAGE" || kind === "OTHER") return { text: null, textStatus: "none" }
  // Page-by-page and row-by-row readers stop a little before the hard limit, so they keep what they read
  const deadline = Date.now() + limits.timeoutMs * 0.8
  const quit = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Extraction>((done) => {
    timer = setTimeout(() => {
      // Tells a reader still going to stop, so it doesn't run on after the answer
      quit.abort()
      done({ text: null, textStatus: "timeout" })
    }, limits.timeoutMs)
  })
  try {
    return await Promise.race([extract(kind, body, limits, { deadline, signal: quit.signal }), timeout])
  } catch (error) {
    console.warn(`[jack] Couldn't read text from a ${kind} file:`, error instanceof Error ? error.message : error)
    return { text: null, textStatus: "failed" }
  } finally {
    clearTimeout(timer)
  }
}

async function extract(kind: JackFileKindKey, body: Buffer, limits: ExtractLimits, stop: Stop): Promise<Extraction> {
  switch (kind) {
    case "PDF":
      return pdfText(body, limits, stop)
    case "DOCUMENT":
      return docxText(body, limits)
    case "SPREADSHEET":
      return xlsxText(body, limits, stop)
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

/** The text capped by characters; `status` says whether the reader already stopped short */
function capped(text: string, limits: ExtractLimits, status: "ok" | "truncated" | "timeout" = "ok"): Extraction {
  const trimmed = text.trim()
  if (!trimmed) return { text: null, textStatus: status === "timeout" ? "timeout" : "none" }
  const result = capText(trimmed, limits.maxChars)
  return { text: result.text, textStatus: status === "ok" && result.truncated ? "truncated" : status }
}

function csvText(text: string, limits: ExtractLimits): Extraction {
  const lines = text.split("\n")
  // The header line plus maxRows rows
  const kept = lines.slice(0, limits.maxRows + 1)
  const more = lines.slice(limits.maxRows + 1).some((line) => line.trim())
  return capped(kept.join("\n"), limits, more ? "truncated" : "ok")
}

async function pdfText(body: Buffer, limits: ExtractLimits, { deadline, signal }: Stop): Promise<Extraction> {
  const scope = globalThis as { pdfjsWorker?: unknown }
  scope.pdfjsWorker ??= pdfjsWorker
  const task = getDocument({ data: new Uint8Array(body), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  // At the hard time limit, destroying the task stops pdf.js even in the middle of a page
  const quit = () => void task.destroy()
  signal.addEventListener("abort", quit, { once: true })
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
      if (signal.aborted || Date.now() > deadline) {
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
    signal.removeEventListener("abort", quit)
    await task.destroy()
  }
}

const WORD_PACKAGE = ["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels"]

/** What mammoth reads from a DOCX for its text: the document, its notes and comments, and the package files that find them */
export function docxParts(limits: ExtractLimits): PartPlan {
  return {
    pick(name) {
      if (name === "word/document.xml") return { group: "document", max: limits.maxXmlBytes }
      if (/^word\/(?:footnotes|endnotes|comments)\.xml$/.test(name)) return { group: "notes", max: limits.maxMammothBytes }
      if (WORD_PACKAGE.includes(name)) return { group: "package", max: 1_000_000 }
      return null
    },
    budgets: { document: limits.maxXmlBytes, notes: limits.maxMammothBytes, package: 3_000_000 },
  }
}

async function docxText(body: Buffer, limits: ExtractLimits): Promise<Extraction> {
  const { parts } = readZipParts(body, docxParts(limits))
  const document = parts.find((part) => part.name === "word/document.xml")
  if (!document) throw new Error("No word/document.xml")
  const whole = parts.filter((part) => !part.cut)
  if (!document.cut && whole.reduce((size, part) => size + part.data.length, 0) <= limits.maxMammothBytes) {
    const mammoth = await import("mammoth")
    const { value } = await (mammoth.default ?? mammoth).extractRawText({ buffer: Buffer.from(packZip(whole)) })
    return capped(normalizeNewlines(value).replace(/\n{3,}/g, "\n\n"), limits)
  }
  // Too big for mammoth: the paragraphs straight from the XML (its start, when it's bigger than maxXmlBytes)
  return capped(wordText(new TextDecoder().decode(document.data)), limits, document.cut ? "truncated" : "ok")
}

/**
 * A Word document's text read straight from its XML, for documents too big for mammoth: paragraphs,
 * tabs and line breaks. Deleted text (w:delText) and field codes (w:instrText) aren't w:t, so they're
 * left out as mammoth leaves them out; a text box's fallback copy (mc:Fallback) is skipped so it isn't
 * read twice. A document cut short just ends where it was cut.
 */
export function wordText(xml: string): string {
  const out: string[] = []
  let inText = false
  let inTabStops = false
  let fallback = 0
  for (const [, closing, tag, selfClosing, text] of xml.matchAll(/<(\/?)([\w.:-]+)[^>]*?(\/?)>|([^<]+)/g)) {
    if (text !== undefined) {
      if (inText && !fallback) out.push(text)
      continue
    }
    if (tag === "mc:Fallback") {
      if (!selfClosing) fallback = Math.max(0, fallback + (closing ? -1 : 1))
      continue
    }
    if (fallback) continue
    if (tag === "w:t") inText = !closing && !selfClosing
    else if (tag === "w:tabs") inTabStops = !closing && !selfClosing
    else if (closing) {
      if (tag === "w:p") out.push("\n\n")
    } else if ((tag === "w:tab" && !inTabStops) || tag === "w:ptab") out.push("\t")
    else if (tag === "w:br" || tag === "w:cr") out.push("\n")
  }
  return decodeEntities(out.join("")).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
}

const SHEET = /^xl\/worksheets\/sheet(\d+)\.xml$/
const WORKBOOK = ["xl/_rels/workbook.xml.rels", "xl/workbook.xml", "xl/styles.xml"]

/** What exceljs reads from an XLSX: the workbook (sheet names, date styles), the shared strings and the sheets */
export function xlsxParts(limits: ExtractLimits): PartPlan {
  return {
    pick(name) {
      if (SHEET.test(name)) return { group: "sheets", max: limits.maxXmlBytes }
      if (name === "xl/sharedStrings.xml") return { group: "strings", max: limits.maxXmlBytes }
      if (WORKBOOK.includes(name)) return { group: "workbook", max: 4_000_000 }
      return null
    },
    budgets: { sheets: limits.maxXmlBytes, strings: limits.maxXmlBytes, workbook: 12_000_000 },
  }
}

const xmlPart = (name: string, xml: string): ZipPart => ({ name, data: new TextEncoder().encode(xml), cut: false })
const NO_STRINGS = xmlPart("xl/sharedStrings.xml", '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>')
const NO_RELATIONSHIPS = xmlPart("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')

/**
 * The parts exceljs reads, packed in the order it needs them: it streams a sheet straight away only
 * once it has the workbook, its relationships and the shared strings (otherwise it spills the sheet to
 * a temporary file). `partial` when a part was cut at maxXmlBytes or left out
 */
function xlsxArchive(body: Buffer, limits: ExtractLimits): { archive: Uint8Array; partial: boolean } {
  const { parts, left } = readZipParts(body, xlsxParts(limits))
  const part = (name: string) => parts.find((p) => p.name === name)
  const sheetNumber = (p: ZipPart) => Number(SHEET.exec(p.name)?.[1])
  const archive = packZip([
    part("xl/_rels/workbook.xml.rels") ?? NO_RELATIONSHIPS,
    ...[part("xl/workbook.xml"), part("xl/styles.xml")].filter((p): p is ZipPart => Boolean(p)),
    part("xl/sharedStrings.xml") ?? NO_STRINGS,
    ...parts.filter((p) => SHEET.test(p.name)).sort((a, b) => sheetNumber(a) - sheetNumber(b)),
  ])
  return { archive, partial: left.length > 0 || parts.some((p) => p.cut) }
}

async function xlsxText(body: Buffer, limits: ExtractLimits, { deadline, signal }: Stop): Promise<Extraction> {
  const { archive, partial } = xlsxArchive(body, limits)
  const exceljs = await import("exceljs")
  const ExcelJS = (exceljs as unknown as { default?: typeof exceljs }).default ?? exceljs
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(pieces(archive)), { worksheets: "emit", sharedStrings: "cache", styles: "cache", hyperlinks: "ignore", entries: "ignore" })
  const out: string[] = []
  let rows = 0
  // Some rows or strings were never read when a part was cut
  let status: "ok" | "truncated" | "timeout" = partial ? "truncated" : "ok"
  read: for await (const sheet of reader) {
    if (rows >= limits.maxRows) {
      status = "truncated"
      break
    }
    const { name, state } = sheet as unknown as { name?: string; state?: string }
    out.push(`## Sheet: ${name}${state && state !== "visible" ? " (hidden)" : ""}`)
    for await (const row of sheet) {
      if (signal.aborted || Date.now() > deadline) {
        status = "timeout"
        break read
      }
      if (!row.hasValues) continue
      if (rows >= limits.maxRows) {
        status = "truncated"
        break read
      }
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      out.push(values.map((value) => csvField(cellText(value as CellValue).slice(0, limits.maxCellChars))).join(",").replace(/,+$/, ""))
      rows++
    }
    out.push("")
  }
  return capped(out.join("\n"), limits, status)
}

/**
 * A buffer as a stream of 64 KB pieces, so the reader takes it a piece at a time and can stop early.
 * Small pieces matter: exceljs turns each piece into a string and a list of every XML event in it
 */
function* pieces(data: Uint8Array, size = 64 * 1024): Generator<Buffer> {
  for (let at = 0; at < data.length; at += size) yield Buffer.from(data.buffer, data.byteOffset + at, Math.min(size, data.length - at))
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
