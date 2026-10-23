import type { JackFileKindKey } from "@/lib/jack/parts"
import { outlineOf } from "@/server/jack/search/paging"

/**
 * How room files read to Jack (design §5): the line under an officer's message that names its files,
 * and the short summary a text-like file gets in the turn it was posted in. Pure, so history.ts can use
 * it and the tests cover it directly.
 */

/** A file as the room's history knows it (the message's READY files) */
export type HistoryFile = { id: string; filename: string; kind: JackFileKindKey; sizeBytes: number; pageCount?: number | null }

/** What a file is, in a word or two */
export const FILE_KIND_LABEL: Record<JackFileKindKey, string> = {
  IMAGE: "photo",
  PDF: "PDF",
  SPREADSHEET: "spreadsheet",
  CSV: "CSV",
  JSON: "JSON",
  TEXT: "text",
  DOCUMENT: "Word document",
  TRANSCRIPT: "transcript",
  OTHER: "file",
}

/** "2.1 MB", "48 KB", "512 bytes" */
export function sizeLabel(bytes: number): string {
  if (bytes < 1_000) return `${bytes} bytes`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`
  const mb = bytes / 1_000_000
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`
}

/** "deck.pdf" (PDF, 2.1 MB, 12 pages; id …), as the officer's turn names a file */
export function fileMention(file: HistoryFile): string {
  const pages = file.kind === "PDF" && file.pageCount ? `, ${file.pageCount} page${file.pageCount === 1 ? "" : "s"}` : ""
  return `${JSON.stringify(shownName(file.filename))} (${FILE_KIND_LABEL[file.kind]}, ${sizeLabel(file.sizeBytes)}${pages}; id ${file.id})`
}

/**
 * A file's name as the officer's turn shows it: with any link in it neutralized, like the file's text
 * (an outside file can be named "www.evil.example.pdf"). room_files gives the name as it is
 */
export function shownName(filename: string): string {
  return neutralizeLinks(filename)
}

/**
 * The line under an officer's message that lists what they attached. It's the same whether the turn is
 * the one being answered (its files follow it, after a note saying so: files/turn.ts) or an earlier one
 * (its files aren't sent again; room_files reads them by id, as the prompt says), so an officer turn's
 * text never changes once it's posted, and it stays in the cached prefix
 */
export function attachmentLine(files: HistoryFile[]): string {
  return `[Attached: ${files.map(fileMention).join(", ")}.]`
}

/*
 * Links in a file's text (and its name) are made unopenable before they go into the officer's turn.
 * web_fetch may open any URL in a user turn (its url_sources take user input, design §7.2), and the turn
 * is where the file's summary goes, so a link planted in an uploaded file would otherwise become
 * fetchable. The full text, links included, stays readable through room_files read: a tool result,
 * which url_sources excludes. A link becomes "[link to example[.]com]": the reader still knows where it
 * pointed. What counts as a link: anything with a scheme (https:evil.example too) or starting www.; a
 * host name followed by a path, a query or a fragment (evil.example/x, evil.example?list=1,
 * evil.example#x); an IPv4 address with a port or followed by a path, a query or a fragment. Host names
 * are read the way a URL parser reads them: labels in any script (пример.com, evil.рф), punycode
 * (evil.xn--p1ai), underscores, invisible format characters (a soft hyphen), the dots IDNA treats as
 * dots (evil。example) and a trailing dot (evil.example./x)
 */
const LINK =
  /\b(?:[a-z][a-z0-9+.-]*:\/\/|https?:|www\.)[^\s<>"'`]+|(?<![\p{L}\p{M}\p{N}\p{Cf}_-])(?:[\p{L}\p{M}\p{N}\p{Cf}_-]+[.。．｡])+(?:xn--[a-z0-9-]+|\p{L}[\p{L}\p{M}\p{Cf}]+)[.。．｡]?(?::\d+)?(?:\/[^\s<>"'`]*|[?#][^\s<>"'`]+)|\b(?:\d{1,3}[.。．｡]){3}\d{1,3}(?::\d+(?:[/?#][^\s<>"'`]*)?|[/?#][^\s<>"'`]*)/giu
const TRAILING = /[.,;:!?)\]}>'"]+$/

export function neutralizeLinks(text: string): string {
  return text.replace(LINK, (match) => {
    const trail = TRAILING.exec(match)?.[0] ?? ""
    const link = trail ? match.slice(0, -trail.length) : match
    return `${linkPlaceholder(link)}${trail}`
  })
}

function linkPlaceholder(link: string): string {
  let host = ""
  try {
    host = new URL(/^(?:[a-z][a-z0-9+.-]*:\/\/|https?:)/i.test(link) ? link : `https://${link}`).hostname
  } catch {
    // Not a URL after all; it still goes
  }
  return host ? `[link to ${host.replace(/\./g, "[.]")}]` : "[link removed]"
}

/** How long a text-like file's summary is, at most, in characters */
export const SUMMARY_CHARS = 2_500
/** How many rows of a CSV, and of each spreadsheet sheet, a summary shows */
const SUMMARY_ROWS = 10
const SUMMARY_SHEET_ROWS = 5
const SUMMARY_SHEETS = 3
/** How many turns of a transcript */
const SUMMARY_TURNS = 8
/** One line of a summary, at most */
const LINE_CHARS = 300

export type SummarySource = { kind: JackFileKindKey; text: string | null; textStatus: string | null; pageCount?: number | null }

/**
 * A short summary of a file's text for the turn it's posted in (design §5: "first rows and headings"):
 * what's in it, then its start. Links are neutralized. A PDF shown as text (over the turn's limits)
 * gets more of its start (`maxChars`).
 */
export function fileSummary(file: SummarySource, maxChars = SUMMARY_CHARS): string {
  const text = file.text?.trim() ?? ""
  if (!text) return file.textStatus === "failed" ? "Its text couldn't be read." : file.kind === "PDF" ? "It has no text to read (a scan, or only pictures)." : "It has no text to read."
  const note = file.textStatus === "truncated" ? " (Its stored text stops at a limit.)" : file.textStatus === "timeout" ? " (Reading it stopped at the time limit; what was read is here.)" : ""
  const { head, body } = summaryParts(file.kind, text, file.pageCount ?? null)
  // Neutralized before it's cut, so the cut can't leave half a link, and the length holds
  const lead = neutralizeLinks(`${head}${note}`)
  return `${lead}\n${clip(neutralizeLinks(body), Math.max(200, maxChars - lead.length - 1))}`
}

function summaryParts(kind: JackFileKindKey, text: string, pageCount: number | null): { head: string; body: string } {
  const lines = text.split("\n")
  switch (kind) {
    case "CSV": {
      const rows = lines.slice(1).filter((line) => line.trim()).length
      return { head: `${count(rows, "row")} under a header row. The header and the first rows:`, body: lines.slice(0, SUMMARY_ROWS + 1).map(clipLine).join("\n") }
    }
    case "SPREADSHEET": {
      const sheets = spreadsheetSheets(text)
      const list = sheets.map((sheet) => `${sheet.name} (${count(sheet.rows.length, "row")})`).join(", ")
      const body = sheets
        .slice(0, SUMMARY_SHEETS)
        .map((sheet) => [`## Sheet: ${sheet.name}`, ...sheet.rows.slice(0, SUMMARY_SHEET_ROWS).map(clipLine)].join("\n"))
        .join("\n\n")
      return { head: `${count(sheets.length, "sheet")}: ${list}. The first rows${sheets.length > SUMMARY_SHEETS ? ` of the first ${SUMMARY_SHEETS}` : ""}:`, body }
    }
    case "JSON":
      return { head: `${jsonShape(text)} The start:`, body: text }
    case "TRANSCRIPT": {
      const turns = lines.filter((line) => line.trim())
      const speakers = [...new Set(turns.map((line) => /^\[[^\]]+\] ([^:]{1,60}): /.exec(line)?.[1]).filter((name): name is string => Boolean(name)))]
      const end = /^\[([^\]]+)\]/.exec(turns.at(-1) ?? "")?.[1]
      const who = speakers.length ? `, ${count(speakers.length, "speaker")}: ${speakers.slice(0, 12).join(", ")}${speakers.length > 12 ? ", …" : ""}` : ""
      return { head: `${count(turns.length, "turn")}${who}${end ? `; the last starts at ${end}` : ""}. The first turns:`, body: turns.slice(0, SUMMARY_TURNS).map(clipLine).join("\n") }
    }
    case "PDF":
      return { head: `${pageCount ? `${count(pageCount, "page")}, ` : ""}${text.length.toLocaleString("en-US")} characters of text. The start:`, body: text }
    default: {
      const outline = outlineOf(text, 15)
      const headings = outline.length ? ` Headings: ${outline.map((entry) => `${"#".repeat(entry.level)} ${entry.heading}`).join("; ")}.` : ""
      const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length
      return { head: `${count(paragraphs, "paragraph")}, ${text.length.toLocaleString("en-US")} characters.${headings} The start:`, body: text }
    }
  }
}

/** A spreadsheet's text (extract.ts writes "## Sheet: <name>" then its rows) as sheets */
function spreadsheetSheets(text: string): { name: string; rows: string[] }[] {
  const sheets: { name: string; rows: string[] }[] = []
  for (const line of text.split("\n")) {
    const heading = /^## Sheet: (.*)$/.exec(line)
    if (heading) sheets.push({ name: heading[1].trim(), rows: [] })
    else if (line.trim()) {
      if (!sheets.length) sheets.push({ name: "Sheet", rows: [] })
      sheets[sheets.length - 1].rows.push(line)
    }
  }
  return sheets
}

function jsonShape(text: string): string {
  try {
    const value: unknown = JSON.parse(text)
    if (Array.isArray(value)) return `A list of ${count(value.length, "item")}.`
    if (value && typeof value === "object") {
      const keys = Object.keys(value)
      return `An object with ${count(keys.length, "key")}: ${keys.slice(0, 15).join(", ")}${keys.length > 15 ? ", …" : ""}.`
    }
    return "A single value."
  } catch {
    // Cut at the extraction's cap, so it no longer parses
    return "JSON (cut short when it was stored)."
  }
}

function count(n: number, one: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`
}

function clipLine(line: string): string {
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line
}

/** The start of `text`, at most `max` characters, cut at a line break when there's one nearby */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf("\n", max - 1)
  return `${text.slice(0, cut > max * 0.6 ? cut : max - 1)}…`
}
