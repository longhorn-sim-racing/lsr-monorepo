import type { JackFileKindKey } from "@/lib/jack/parts"
import { capText, EXTRACT_LIMITS, extractText, type ExtractLimits, type TextStatus } from "@/server/jack/files/extract"
import { checkContent } from "@/server/jack/files/magic"
import { inspectZip, OFFICE_ZIP_LIMITS, readZipParts, ZipLimitError, type PartPlan } from "@/server/jack/files/zip"

/**
 * Text from the club's synced documents (design §12.7, §12.8): Google Drive and SharePoint files go
 * through the same pipeline as room files (G5's extractors and checks), so a document is capped and
 * parsed exactly like an attachment. PowerPoint files (which rooms don't take) get a small slide reader
 * here, with the same ZIP checks. Transcripts (.vtt) come out speaker-tagged, so a "Transcripts" folder
 * in Drive or SharePoint is just more documents (design §12.8, path 2).
 */

/**
 * ExternalDocument.textStatus:
 * - ok / truncated: the text is stored (truncated: cut at a cap, or the reader ran out of time)
 * - too_large: over the export or download cap, so it was never read
 * - unsupported: a kind of file whose text isn't read (images, videos, drawings, forms)
 * - restricted: the owner turned off downloads for viewers
 * - none: readable, but there was no text in it (a scanned PDF, an empty document)
 * - error: the file couldn't be read (damaged, or not what its name says)
 */
export type DocumentTextStatus = "ok" | "truncated" | "too_large" | "unsupported" | "restricted" | "none" | "error"

export type DocumentText = { text: string | null; textStatus: DocumentTextStatus }

/** Exports are capped at 10 MB by Google itself; downloads at 20 MB (functions hold the bytes in memory) */
export const DOCUMENT_LIMITS = { maxExportBytes: 10_000_000, maxDownloadBytes: 20_000_000 }

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
export const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

/** How a file's text is read: one of G5's kinds (with the content type its checks expect), or a slide deck */
export type DocumentReader = { kind: JackFileKindKey; contentType: string } | { kind: "PRESENTATION"; contentType: typeof PPTX }

const BY_EXTENSION: Record<string, DocumentReader> = {
  pdf: { kind: "PDF", contentType: "application/pdf" },
  docx: { kind: "DOCUMENT", contentType: DOCX },
  xlsx: { kind: "SPREADSHEET", contentType: XLSX },
  pptx: { kind: "PRESENTATION", contentType: PPTX },
  csv: { kind: "CSV", contentType: "text/csv" },
  json: { kind: "JSON", contentType: "application/json" },
  txt: { kind: "TEXT", contentType: "text/plain" },
  md: { kind: "TEXT", contentType: "text/markdown" },
  markdown: { kind: "TEXT", contentType: "text/markdown" },
  vtt: { kind: "TRANSCRIPT", contentType: "text/vtt" },
}

const BY_TYPE: Record<string, DocumentReader> = {
  "application/pdf": BY_EXTENSION.pdf,
  [DOCX]: BY_EXTENSION.docx,
  [XLSX]: BY_EXTENSION.xlsx,
  [PPTX]: BY_EXTENSION.pptx,
  "text/csv": BY_EXTENSION.csv,
  "application/json": BY_EXTENSION.json,
  "text/plain": BY_EXTENSION.txt,
  "text/markdown": BY_EXTENSION.md,
  "text/x-markdown": BY_EXTENSION.md,
  "text/vtt": BY_EXTENSION.vtt,
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/**
 * How to read a stored file, from its name, then its type; null when its text isn't read. Macro files
 * (.docm, .xlsm, .pptm) and old binary Office files never match, so they're "unsupported"
 */
export function documentReader(name: string, mimeType: string): DocumentReader | null {
  return BY_EXTENSION[extensionOf(name)] ?? BY_TYPE[mimeType.split(";")[0].trim().toLowerCase()] ?? null
}

/** G5's statuses as a document's: what was read is kept, a time-out keeps its partial text */
function fromFileStatus(text: string | null, status: TextStatus): DocumentTextStatus {
  if (status === "failed") return "error"
  if (text === null) return status === "timeout" ? "error" : "none"
  return status === "ok" ? "ok" : "truncated"
}

/**
 * A downloaded or exported file's text. Binary files are checked first (magic bytes, and for Office files
 * the ZIP: no macros, no zip bombs, the layout every reader agrees on), so a renamed or damaged file is
 * "error" and never reaches a parser.
 */
export async function documentText(reader: DocumentReader, body: Buffer, limits: ExtractLimits = EXTRACT_LIMITS): Promise<DocumentText> {
  if (reader.kind === "PRESENTATION") return presentationText(body, limits)
  const check = checkContent(reader.contentType, body)
  if (!check.ok) return { text: null, textStatus: "error" }
  const { text, textStatus } = await extractText(reader.kind, body, limits)
  return { text, textStatus: fromFileStatus(text, textStatus) }
}

const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/
const NOTES = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/

/** What the slide reader takes out of a PPTX: the slides and their speaker notes, each capped */
function presentationParts(limits: ExtractLimits): PartPlan {
  return {
    pick(name) {
      if (SLIDE.test(name)) return { group: "slides", max: limits.maxXmlBytes }
      if (NOTES.test(name)) return { group: "notes", max: limits.maxXmlBytes }
      return null
    },
    budgets: { slides: limits.maxXmlBytes, notes: Math.floor(limits.maxXmlBytes / 4) },
  }
}

/**
 * A PowerPoint deck's text, slide by slide ("--- Slide 3 ---"), with each slide's notes after it.
 * Checked like G5's Office files: a ZIP that inflates within the caps, a presentation inside, no macros
 */
export async function presentationText(body: Buffer, limits: ExtractLimits = EXTRACT_LIMITS): Promise<DocumentText> {
  if (body.subarray(0, 4).toString("latin1") !== "PK\x03\x04") return { text: null, textStatus: "error" }
  try {
    const { names } = inspectZip(body, OFFICE_ZIP_LIMITS)
    if (!names.includes("ppt/presentation.xml") || names.includes("ppt/vbaProject.bin")) return { text: null, textStatus: "error" }
    const { parts, left } = readZipParts(body, presentationParts(limits))
    const number = (name: string, pattern: RegExp) => Number(pattern.exec(name)?.[1])
    const notes = new Map(parts.filter((p) => NOTES.test(p.name)).map((p) => [number(p.name, NOTES), slideXmlText(new TextDecoder().decode(p.data))]))
    const slides = parts.filter((p) => SLIDE.test(p.name)).sort((a, b) => number(a.name, SLIDE) - number(b.name, SLIDE))
    const out: string[] = []
    for (const slide of slides) {
      const n = number(slide.name, SLIDE)
      const text = slideXmlText(new TextDecoder().decode(slide.data))
      const note = notes.get(n)
      if (text || note) out.push(`--- Slide ${n} ---${text ? `\n${text}` : ""}${note ? `\nNotes: ${note}` : ""}`)
    }
    const whole = out.join("\n\n").trim()
    if (!whole) return { text: null, textStatus: "none" }
    const result = capText(whole, limits.maxChars)
    const cut = result.truncated || left.length > 0 || parts.some((p) => p.cut)
    return { text: result.text, textStatus: cut ? "truncated" : "ok" }
  } catch (error) {
    if (!(error instanceof ZipLimitError)) console.warn("[documents] Couldn't read a presentation:", error instanceof Error ? error.message : error)
    return { text: null, textStatus: "error" }
  }
}

/** The text runs (a:t) of a slide, one line per paragraph (a:p); line breaks (a:br) and tabs kept */
export function slideXmlText(xml: string): string {
  const lines: string[] = []
  let line = ""
  let inText = false
  for (const [, closing, tag, selfClosing, text] of xml.matchAll(/<(\/?)([\w.:-]+)[^>]*?(\/?)>|([^<]+)/g)) {
    if (text !== undefined) {
      if (inText) line += text
      continue
    }
    if (tag === "a:t") inText = !closing && !selfClosing
    else if (tag === "a:br" && !closing) line += "\n"
    else if (tag === "a:tab" && !closing) line += "\t"
    else if (tag === "a:p" && (closing || selfClosing)) {
      if (line.trim()) lines.push(line.trim())
      line = ""
    }
  }
  if (line.trim()) lines.push(line.trim())
  return decodeXml(lines.join("\n"))
}

function decodeXml(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()] ?? whole
  })
}

/*
 * Characters that change how a name reads without being visible: controls, and the bidirectional
 * overrides that make "budget‮fdp.exe" show as "budgetexe.pdf"
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g

/** A name or folder from Drive or SharePoint as officers and Jack see it: no invisible characters, one line, at most 300 characters */
export function cleanDocumentName(name: string): string {
  const clean = name.normalize("NFC").replace(/[\t\n\r\f\v]+/g, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim()
  return (clean.length > 300 ? `${clean.slice(0, 299)}…` : clean) || "Untitled"
}

/** "/Events/2026": a folder path from its folder names, top level first ("/" for the top level) */
export function folderPath(names: string[]): string {
  return `/${names.map((name) => cleanDocumentName(name).replace(/\//g, "∕")).join("/")}`
}
