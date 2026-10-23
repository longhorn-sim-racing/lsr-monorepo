import { uniqueHeaders } from "@/lib/csv"

/**
 * The rows of a spreadsheet or CSV file attached in a room, read from the text G5's extractors saved at
 * registration (src/server/jack/files/extract.ts): a CSV's text as it is, and a workbook as CSV per
 * sheet under "## Sheet: <name>" lines (5,000 rows in all at most). Pure, so it's tested on its own.
 */

export type Table = {
  /** The sheet's name, for a workbook */
  sheet: string | null
  /** Every sheet in the file, for a workbook */
  sheets: string[]
  /** The first row's cells, made unique ("Name", "Name (2)") */
  headers: string[]
  /** The rows under the header that have something in them */
  rows: string[][]
}

/** RFC 4180 records: quoted fields, doubled quotes, line breaks inside quotes */
export function parseCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let cell = ""
  let quoted = false
  let fieldStart = true
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
      continue
    }
    if (c === '"' && fieldStart) {
      quoted = true
      fieldStart = false
    } else if (c === ",") {
      record.push(cell)
      cell = ""
      fieldStart = true
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      record.push(cell)
      records.push(record)
      record = []
      cell = ""
      fieldStart = true
    } else {
      cell += c
      fieldStart = false
    }
  }
  if (cell || record.length) {
    record.push(cell)
    records.push(record)
  }
  return records
}

const SHEET_LINE = /^## Sheet: (.*?)(?: \(hidden\))?$/

/** A workbook's text split into its sheets; a CSV is one sheet without a name */
function sheetsOf(text: string, workbook: boolean): { name: string | null; records: string[][] }[] {
  const records = parseCsv(text)
  if (!workbook) return [{ name: null, records }]
  const sheets: { name: string | null; records: string[][] }[] = []
  for (const record of records) {
    const header = record.length === 1 ? SHEET_LINE.exec(record[0]) : null
    if (header) sheets.push({ name: header[1], records: [] })
    else if (sheets.length) sheets[sheets.length - 1].records.push(record)
  }
  return sheets
}

const filled = (record: string[]) => record.some((cell) => cell.trim())

/**
 * The table in a file's text: the named sheet (any case), or the first with rows under its header.
 * Throws an Error with a message for the model when the sheet isn't there or nothing is in it
 */
export function readTable(text: string, options: { workbook: boolean; sheet?: string; filename: string }): Table {
  const sheets = sheetsOf(text.replace(/^﻿/, ""), options.workbook)
  const names = sheets.map((s) => s.name).filter((n): n is string => n !== null)
  const wanted = options.sheet?.trim().toLowerCase()
  const pick = wanted ? sheets.find((s) => s.name?.toLowerCase() === wanted) : sheets.find((s) => s.records.filter(filled).length > 1)
  if (!pick) {
    if (wanted) throw new Error(`${options.filename} has no sheet “${options.sheet}”. Its sheets: ${names.join(", ") || "none"}.`)
    throw new Error(`${options.filename} has no rows under a header row.`)
  }
  const [header, ...rest] = pick.records.filter(filled)
  if (!header) throw new Error(`${options.filename}${pick.name ? ` (sheet “${pick.name}”)` : ""} is empty.`)
  const headers = uniqueHeaders(header.map((cell, i) => cell.trim() || `Column ${i + 1}`))
  return { sheet: pick.name, sheets: names, headers, rows: rest.map((row) => row.map((cell) => cell.trim())) }
}
