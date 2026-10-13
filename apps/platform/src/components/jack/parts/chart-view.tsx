"use client"

import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Table, TD, TH, THead, TR } from "@/components/admin/kit"
import type { JackCellValue, JackChartSpec } from "@/lib/jack/parts"

/**
 * A chart Jack drew (#161). LSR orange for a single series; for several, a fixed order of six hues
 * checked for color-blind separation against the panel (orange, blue, aqua, violet, pink, green), with
 * lighter versions in the dark theme. Identity never rests on color alone: two or more series get a
 * legend, and "Show data" has every value as a table.
 */

/* The admin theme's variables (globals.css), so charts follow light and dark; SVG attributes take var() too */
export const SERIES_COLORS = [1, 2, 3, 4, 5, 6].map((n) => `var(--series-${n})`)
const OTHER_COLOR = "var(--series-other)"
const MAX_SLICES = 6

const INK = "var(--foreground)"
const SUBTLE = "var(--admin-subtle)"
const GRID = "var(--admin-row)"
const BORDER = "var(--border)"
const PANEL = "var(--card)"

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const full = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
const formatValue = (value: unknown) => (typeof value === "number" ? full.format(value) : String(value ?? "—"))

const tooltipStyle = {
  contentStyle: { background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 12, padding: "6px 10px", color: INK },
  labelStyle: { color: INK, fontWeight: 600, marginBottom: 2 },
  itemStyle: { padding: 0, color: INK },
}

/** Pie slices: the largest five, then everything else as "Other" */
export function pieSlices(chart: JackChartSpec) {
  const key = chart.series[0]?.key
  const slices = chart.rows
    .map((row) => ({ name: String(row[chart.xKey] ?? "—"), value: typeof row[key] === "number" ? (row[key] as number) : 0 }))
    .filter((s) => s.value > 0)
  if (slices.length <= MAX_SLICES) return slices.map((s, i) => ({ ...s, color: SERIES_COLORS[i] }))
  const sorted = [...slices].sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, MAX_SLICES - 1).map((s, i) => ({ ...s, color: SERIES_COLORS[i] }))
  const rest = sorted.slice(MAX_SLICES - 1).reduce((sum, s) => sum + s.value, 0)
  return [...head, { name: "Other", value: rest, color: OTHER_COLOR }]
}

/** Whether every value a chart plots is a whole number (counts), so the value axis shouldn't show 0.5 steps */
export function allWholeNumbers(chart: JackChartSpec): boolean {
  return chart.rows.every((row) => chart.series.every((s) => typeof row[s.key] !== "number" || Number.isInteger(row[s.key])))
}

export function ChartView({ chart }: { chart: JackChartSpec }) {
  const series = chart.series.slice(0, SERIES_COLORS.length)
  const color = (i: number) => (series.length === 1 ? SERIES_COLORS[0] : SERIES_COLORS[i])
  const slices = chart.type === "pie" ? pieSlices(chart) : []
  const total = slices.reduce((sum, s) => sum + s.value, 0)
  const summary = `${chart.type} chart: ${chart.title}, ${chart.rows.length} ${chart.rows.length === 1 ? "row" : "rows"}`

  const axes = (
    <>
      <CartesianGrid vertical={false} stroke={GRID} />
      <XAxis
        dataKey={chart.xKey}
        tick={{ fontSize: 11, fill: SUBTLE }}
        tickLine={false}
        axisLine={{ stroke: BORDER }}
        interval="preserveStartEnd"
        minTickGap={12}
        padding={chart.type === "line" ? { left: 12, right: 12 } : undefined}
      />
      <YAxis
        allowDecimals={!allWholeNumbers(chart)}
        tick={{ fontSize: 11, fill: SUBTLE }}
        tickLine={false}
        axisLine={false}
        tickFormatter={(v: number) => compact.format(v)}
        width={chart.yLabel ? 52 : 40}
        label={chart.yLabel ? { value: chart.yLabel, angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 11, fill: SUBTLE, textAnchor: "middle" } } : undefined}
      />
    </>
  )

  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="font-semibold">{chart.title}</figcaption>

      {chart.type !== "pie" && series.length > 1 && <Legend items={series.map((s, i) => ({ label: s.label, color: color(i), line: chart.type === "line" }))} />}

      <div role="img" aria-label={summary} className="h-[260px] w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 260 }}>
          {chart.type === "bar" ? (
            <BarChart data={chart.rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
              {axes}
              <Tooltip cursor={{ fill: GRID, opacity: 0.6 }} formatter={(value) => formatValue(value)} {...tooltipStyle} />
              {series.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={color(i)} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
              ))}
            </BarChart>
          ) : chart.type === "line" ? (
            <LineChart data={chart.rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              {axes}
              <Tooltip cursor={{ stroke: BORDER }} formatter={(value) => formatValue(value)} {...tooltipStyle} />
              {series.map((s, i) => (
                <Line
                  key={s.key}
                  type="linear"
                  dataKey={s.key}
                  name={s.label}
                  stroke={color(i)}
                  strokeWidth={2}
                  dot={chart.rows.length <= 24 ? { r: 3.5, fill: color(i), stroke: PANEL, strokeWidth: 2 } : false}
                  activeDot={{ r: 5, stroke: PANEL, strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          ) : (
            <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
              <Tooltip formatter={(value) => formatValue(value)} {...tooltipStyle} />
              <Pie data={slices} dataKey="value" nameKey="name" startAngle={90} endAngle={-270} innerRadius="55%" outerRadius="85%" stroke={PANEL} strokeWidth={2} isAnimationActive={false}>
                {slices.map((slice) => (
                  <Cell key={slice.name} fill={slice.color} />
                ))}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>

      {chart.type === "pie" && (
        <Legend
          items={slices.map((s) => ({
            label: `${s.name} · ${full.format(s.value)}${total ? ` (${Math.round((s.value / total) * 100)}%)` : ""}`,
            color: s.color,
          }))}
        />
      )}

      <details className="group text-xs">
        <summary className="cursor-pointer list-none text-admin-subtle hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span className="underline-offset-2 group-hover:underline">Show data</span>
        </summary>
        <div className="mt-2">
          <Table minWidth={Math.min(560, Math.max(240, (series.length + 1) * 110))} className="max-h-64 overflow-y-auto">
            <THead>
              <TH>{chart.xKey}</TH>
              {series.map((s) => (
                <TH key={s.key} className="text-right">
                  {s.label}
                </TH>
              ))}
            </THead>
            <tbody>
              {chart.rows.map((row, r) => (
                <TR key={r}>
                  <TD className="py-1.5">{display(row[chart.xKey])}</TD>
                  {series.map((s) => (
                    <TD key={s.key} className="py-1.5 text-right tabular-nums">
                      {display(row[s.key])}
                    </TD>
                  ))}
                </TR>
              ))}
            </tbody>
          </Table>
        </div>
      </details>
    </figure>
  )
}

function display(value: JackCellValue | undefined) {
  if (value === null || value === undefined) return <span className="text-admin-subtle">—</span>
  return typeof value === "number" ? full.format(value) : String(value)
}

function Legend({ items }: { items: { label: string; color: string; line?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden className={item.line ? "h-0.5 w-3 rounded-full" : "size-2.5 rounded-sm"} style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  )
}
