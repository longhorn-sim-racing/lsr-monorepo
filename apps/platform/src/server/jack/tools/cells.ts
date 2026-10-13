import type { JackCellValue } from "@/lib/jack/parts"

/** Longest string a single cell keeps; the rest is cut with a note, so one big JSON column can't eat the budget */
export const MAX_CELL_CHARS = 1_000

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (+${text.length - max} chars)`
}

function isDecimal(value: object): value is { toNumber(): number; toString(): string } {
  const v = value as { toFixed?: unknown; toNumber?: unknown }
  return typeof v.toFixed === "function" && typeof v.toNumber === "function"
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ?? "null"
}

/**
 * Turns whatever Prisma's raw queries return into plain JSON: BigInt and Decimal become numbers when
 * that's exact (strings when not), dates become ISO strings (UTC), bytes become a size, JSON and
 * arrays become JSON text.
 */
export function toCell(value: unknown, maxChars = MAX_CELL_CHARS): JackCellValue {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case "string":
      return cut(value, maxChars)
    case "boolean":
      return value
    case "number":
      return Number.isFinite(value) ? value : String(value)
    case "bigint":
      return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
    case "object": {
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
      if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`
      if (isDecimal(value)) {
        const text = value.toString()
        const n = value.toNumber()
        return Number.isFinite(n) && String(n) === text ? n : text
      }
      return cut(jsonText(value), maxChars)
    }
    default:
      return cut(String(value), maxChars)
  }
}

/** Rows of objects (what $queryRaw returns) as column names plus rows of cells */
export function toGrid(rows: Record<string, unknown>[], maxChars = MAX_CELL_CHARS): { columns: string[]; rows: JackCellValue[][] } {
  const columns = rows.length ? Object.keys(rows[0]) : []
  return { columns, rows: rows.map((row) => columns.map((column) => toCell(row[column], maxChars))) }
}

/**
 * Keeps as many rows as fit in `maxChars` of JSON once wrapped by `build`. Returns the JSON and how
 * many rows made it. Always keeps at least the shape (zero rows) so the model sees the columns.
 */
export function fitRows<T>(rows: T[], build: (rows: T[]) => unknown, maxChars: number): { text: string; kept: number } {
  let text = jsonText(build(rows))
  if (text.length <= maxChars) return { text, kept: rows.length }
  // Binary search on the row count: JSON length grows with it
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (jsonText(build(rows.slice(0, mid))).length <= maxChars) lo = mid
    else hi = mid - 1
  }
  text = jsonText(build(rows.slice(0, lo)))
  return { text, kept: lo }
}

export { jsonText }
