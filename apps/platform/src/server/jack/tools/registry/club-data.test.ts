import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import { JACK_TOOLS } from "../index"
import { TOOLS } from "./club-data"

/** The most the club-data track's tool definitions may add to the cached prompt, in characters (design §8) */
const TRACK_TOOLS_MAX_CHARS = 12_000

describe("the club-data tools", () => {
  it("are search and read (always loaded), then recruiting_pipeline and race_performance (behind tool search)", () => {
    expect(TOOLS.map((t) => [t.name, Boolean(t.deferred)])).toEqual([
      ["search", false],
      ["read", false],
      ["recruiting_pipeline", true],
      ["race_performance", true],
    ])
    for (const tool of TOOLS) expect(JACK_TOOLS).toContain(tool)
    expect(TOOLS.some((t) => t.writes)).toBe(false)
  })

  it("stay within the track's size budget for tool definitions", () => {
    const size = TOOLS.reduce((n, tool) => n + JSON.stringify({ name: tool.name, description: tool.description, input_schema: z.toJSONSchema(tool.input) }).length, 0)
    expect(size).toBeLessThanOrEqual(TRACK_TOOLS_MAX_CHARS)
  })
})
