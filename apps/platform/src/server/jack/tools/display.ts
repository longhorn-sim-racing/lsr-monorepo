import type { JackCellValue, JackToolDisplay } from "@/lib/jack/parts"
import { jsonText, toCell } from "./cells"

/** Most rows a typed tool shows in the room; the model still gets everything it asked for */
export const DISPLAY_ROWS = 50

/** A table display from rows of objects, picking and naming the columns to show */
export function tableDisplay<T>(
  rows: T[],
  columns: { header: string; value: (row: T) => unknown }[],
  caption?: string,
): Extract<JackToolDisplay, { kind: "table" }> {
  const shown = rows.slice(0, DISPLAY_ROWS)
  return {
    kind: "table",
    columns: columns.map((c) => c.header),
    rows: shown.map((row) => columns.map((c) => toCell(c.value(row), 200) as JackCellValue)),
    truncated: shown.length < rows.length,
    caption: shown.length < rows.length ? `${caption ? `${caption} · ` : ""}first ${shown.length} of ${rows.length}` : caption,
  }
}

/** Compact JSON for the model (no indentation; BigInt-safe) */
export function forModel(value: unknown): string {
  return jsonText(value)
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}
