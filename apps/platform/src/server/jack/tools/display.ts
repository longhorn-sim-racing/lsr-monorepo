import type { JackCellValue, JackToolDisplay } from "@/lib/jack/parts"
import { fitRows, jsonText, toCell } from "./cells"

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

/** Most characters a typed tool sends back, about 5k tokens; the same cap run_sql uses */
export const MAX_MODEL_CHARS = 20_000

/**
 * The result as JSON with its list under `key`, keeping as many list items as fit in `max` characters
 * and saying so when some were left out.
 */
export function forModelWithList<T>(base: Record<string, unknown>, key: string, items: T[], max = MAX_MODEL_CHARS): string {
  return fitRows(
    items,
    (kept) => ({
      ...base,
      [key]: kept,
      ...(kept.length < items.length ? { [`${key}Note`]: `Only the first ${kept.length} of ${items.length} ${key} fit in this reply. Narrow the request to see the rest.` } : {}),
    }),
    max,
  ).text
}

/** One list in a result for forModelWithLists. `keep: "last"` trims from the start (e.g. older periods) */
export type ModelList = { key: string; items: unknown[]; keep?: "first" | "last" }

/**
 * Like forModelWithList for a result with several lists: each is trimmed to fit in `max` characters
 * along with the lists before it, so earlier lists get the room first. Each trimmed list gets a note.
 */
export function forModelWithLists(base: Record<string, unknown>, lists: ModelList[], max = MAX_MODEL_CHARS): string {
  let fixed: Record<string, unknown> = { ...base }
  for (const { key } of lists) delete fixed[key]
  let text = jsonText(fixed)
  for (const { key, items, keep = "first" } of lists) {
    const ordered = keep === "last" ? [...items].reverse() : items
    const shape = (kept: unknown[]) => {
      const inOrder = keep === "last" ? [...kept].reverse() : kept
      return {
        ...fixed,
        [key]: inOrder,
        ...(kept.length < items.length
          ? { [`${key}Note`]: `Only the ${keep} ${kept.length} of ${items.length} ${key} fit in this reply. Narrow the request to see the rest.` }
          : {}),
      }
    }
    const fitted = fitRows(ordered, shape, max)
    fixed = shape(ordered.slice(0, fitted.kept))
    text = fitted.text
  }
  return text
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}
