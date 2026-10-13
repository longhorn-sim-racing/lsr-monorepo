import { describe, expect, it } from "vitest"
import { buildChart, chartInput, chartTool, MAX_CHART_ROWS, type ChartInput } from "./chart"

const ctx = { roomId: "room-1", actor: { userId: "u1", displayName: "Alex" } }

const bar = (overrides: Partial<ChartInput> = {}): ChartInput => ({
  type: "bar",
  title: "Signups by month",
  xKey: "month",
  series: [{ key: "signups", label: "Signups" }],
  rows: [
    { month: "2026-09", signups: 12 },
    { month: "2026-10", signups: "7" },
  ],
  ...overrides,
})

describe("buildChart", () => {
  it("accepts a valid spec and turns numeric strings into numbers", () => {
    const result = buildChart(bar({ yLabel: "Members" }))
    expect(result).toEqual({
      ok: true,
      dropped: 0,
      chart: {
        type: "bar",
        title: "Signups by month",
        xKey: "month",
        series: [{ key: "signups", label: "Signups" }],
        rows: [
          { month: "2026-09", signups: 12 },
          { month: "2026-10", signups: 7 },
        ],
        yLabel: "Members",
      },
    })
  })

  it("reads $ and thousands separators, and keeps gaps as null", () => {
    const result = buildChart(bar({ rows: [{ month: "a", signups: "$1,250.50" }, { month: "b", signups: null }, { month: "c" }] }))
    expect(result.ok && result.chart.rows).toEqual([
      { month: "a", signups: 1250.5 },
      { month: "b", signups: null },
      { month: "c", signups: null },
    ])
  })

  it("drops rows past the cap and says how many", () => {
    const rows = Array.from({ length: MAX_CHART_ROWS + 7 }, (_, i) => ({ month: String(i), signups: i }))
    const result = buildChart(bar({ rows }))
    expect(result.ok && result.chart.rows).toHaveLength(MAX_CHART_ROWS)
    expect(result.ok && result.dropped).toBe(7)
  })

  it("rejects specs that don't match their rows", () => {
    expect(buildChart(bar({ xKey: "week" }))).toEqual({ ok: false, error: expect.stringContaining('No row has the xKey "week"') })
    expect(buildChart(bar({ series: [{ key: "signups", label: "A" }, { key: "signups", label: "B" }] }))).toMatchObject({ ok: false })
    expect(buildChart(bar({ series: [{ key: "month", label: "Month" }] }))).toEqual({ ok: false, error: expect.stringContaining("can't also be a series") })
    expect(buildChart(bar({ rows: [{ month: "a", signups: "lots" }] }))).toEqual({ ok: false, error: expect.stringContaining("not a number") })
    expect(buildChart(bar({ series: [{ key: "other", label: "Other" }] }))).toEqual({ ok: false, error: expect.stringContaining("None of the rows") })
  })

  it("holds pies to one series, a few slices and no negatives", () => {
    const pie = (o: Partial<ChartInput>) => bar({ type: "pie", ...o })
    expect(buildChart(pie({ series: [{ key: "a", label: "A" }, { key: "b", label: "B" }] }))).toEqual({ ok: false, error: expect.stringContaining("exactly one series") })
    expect(buildChart(pie({ rows: Array.from({ length: 13 }, (_, i) => ({ month: String(i), signups: 1 })) }))).toEqual({ ok: false, error: expect.stringContaining("more than 12 slices") })
    expect(buildChart(pie({ rows: [{ month: "a", signups: -1 }] }))).toEqual({ ok: false, error: expect.stringContaining("can't be negative") })
    expect(buildChart(pie({})).ok).toBe(true)
  })
})

describe("chart input schema", () => {
  it("is what the model loop validates with", () => {
    expect(chartInput.safeParse(bar()).success).toBe(true)
    expect(chartInput.safeParse({ ...bar(), type: "scatter" }).success).toBe(false)
    expect(chartInput.safeParse({ ...bar(), title: " " }).success).toBe(false)
    expect(chartInput.safeParse({ ...bar(), series: [] }).success).toBe(false)
    expect(chartInput.safeParse({ ...bar(), rows: [] }).success).toBe(false)
    expect(chartInput.safeParse({ ...bar(), rows: [{ month: { nested: true } }] }).success).toBe(false)
  })
})

describe("chart tool", () => {
  it("returns a chart display and a short acknowledgement", async () => {
    const result = await chartTool.run(bar(), ctx)
    expect(result.isError).toBeUndefined()
    expect(result.forModel).toBe('Chart shown in the room: bar "Signups by month", 2 rows, 1 series.')
    expect(result.label).toBe("Drew a bar chart: Signups by month")
    expect(result.displays).toHaveLength(1)
    expect(result.displays?.[0].kind).toBe("chart")
  })

  it("returns an error the model can fix", async () => {
    const result = await chartTool.run(bar({ xKey: "nope" }), ctx)
    expect(result).toMatchObject({ isError: true, label: "Chart not drawn", displays: [] })
  })
})
