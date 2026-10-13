import { z } from "zod"
import type { JackCellValue, JackChartSpec } from "@/lib/jack/parts"
import type { JackTool } from "./types"

/**
 * chart: Jack hands over rows he already has (from a query or a typed tool) and the room draws them
 * with recharts (#161). The tool only checks the spec; it reads nothing.
 */

export const MAX_CHART_ROWS = 100
export const MAX_CHART_SERIES = 6
export const MAX_PIE_SLICES = 12

const cell = z.union([z.string().max(200), z.number(), z.boolean(), z.null()])

export const chartInput = z.object({
  type: z.enum(["bar", "line", "pie"]).describe("bar for comparing categories, line for change over time, pie only for a few parts of one whole"),
  title: z.string().trim().min(1).max(120).describe("What the chart shows, e.g. \"Signups by month, 2026\""),
  xKey: z.string().min(1).max(64).describe("The row key holding the category or date label (the x axis, or the pie slice names)"),
  series: z
    .array(z.object({ key: z.string().min(1).max(64), label: z.string().trim().min(1).max(60) }))
    .min(1)
    .max(MAX_CHART_SERIES)
    .describe(`The numeric row keys to plot, each with a legend label (1 to ${MAX_CHART_SERIES}; a pie takes exactly 1)`),
  rows: z
    .array(z.record(z.string(), cell))
    .min(1)
    .max(MAX_CHART_ROWS * 5)
    .describe(`The data, one object per x value, in display order. At most ${MAX_CHART_ROWS} rows are drawn.`),
  yLabel: z.string().trim().max(60).optional().describe("Value axis label for bar and line, e.g. \"Members\" or \"Dollars\""),
})

export type ChartInput = z.infer<typeof chartInput>

/** Checks a chart spec against its rows; numeric strings become numbers. Errors are written for the model. */
export function buildChart(input: ChartInput): { ok: true; chart: JackChartSpec; dropped: number } | { ok: false; error: string } {
  const dropped = Math.max(0, input.rows.length - MAX_CHART_ROWS)
  const rows = input.rows.slice(0, MAX_CHART_ROWS)

  if (!rows.some((row) => input.xKey in row)) return { ok: false, error: `No row has the xKey "${input.xKey}". Row keys: ${Object.keys(rows[0]).join(", ")}.` }
  const keys = input.series.map((s) => s.key)
  if (new Set(keys).size !== keys.length) return { ok: false, error: "Each series needs its own key." }
  if (keys.includes(input.xKey)) return { ok: false, error: `"${input.xKey}" is the xKey; it can't also be a series.` }
  if (input.type === "pie") {
    if (input.series.length !== 1) return { ok: false, error: "A pie chart takes exactly one series (the slice sizes)." }
    if (rows.length > MAX_PIE_SLICES) return { ok: false, error: `A pie chart can't have more than ${MAX_PIE_SLICES} slices; use a bar chart, or group the small ones into "Other".` }
  }

  const clean: Record<string, JackCellValue>[] = []
  for (const [i, row] of rows.entries()) {
    const out: Record<string, JackCellValue> = { [input.xKey]: row[input.xKey] ?? null }
    for (const key of keys) {
      const value = row[key]
      if (value === undefined || value === null || value === "") {
        out[key] = null
        continue
      }
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[$,]/g, "")) : NaN
      if (!Number.isFinite(n)) return { ok: false, error: `Row ${i + 1}: "${key}" is ${JSON.stringify(value)}, not a number.` }
      if (input.type === "pie" && n < 0) return { ok: false, error: `Row ${i + 1}: a pie slice can't be negative.` }
      out[key] = n
    }
    clean.push(out)
  }
  if (!keys.some((key) => clean.some((row) => row[key] !== null))) {
    return { ok: false, error: `None of the rows have values for ${keys.map((k) => `"${k}"`).join(", ")}.` }
  }

  return {
    ok: true,
    dropped,
    chart: { type: input.type, title: input.title, xKey: input.xKey, series: input.series, rows: clean, ...(input.yLabel ? { yLabel: input.yLabel } : {}) },
  }
}

export const chartTool: JackTool<ChartInput> = {
  name: "chart",
  description:
    "Draw a bar, line or pie chart in the room from rows you already have (from run_sql or a typed tool). Pass the rows, which key is the x axis (or slice name) and which numeric keys to plot. Use line for change over time, bar to compare categories, pie only for 2 to 6 parts of one whole. Dates should be Central-time labels like 2026-10 or 2026-10-19. The room also gets the rows as a table, so don't repeat every number in your answer.",
  input: chartInput,
  async run(input) {
    const built = buildChart(input)
    if (!built.ok) return { isError: true, forModel: built.error, label: "Chart not drawn", displays: [] }
    const { chart, dropped } = built
    return {
      forModel: `Chart shown in the room: ${chart.type} "${chart.title}", ${chart.rows.length} rows, ${chart.series.length} series.${dropped ? ` ${dropped} rows past the first ${MAX_CHART_ROWS} were left out.` : ""}`,
      label: `Drew a ${chart.type} chart: ${chart.title}`,
      displays: [{ kind: "chart", chart }],
    }
  },
}
