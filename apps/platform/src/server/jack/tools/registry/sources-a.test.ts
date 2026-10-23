import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import { JACK_TOOLS } from "../index"
import { TOOLS } from "./sources-a"

/** The most the sources-a track's tool definitions may add to the request, in characters (design §8). Deferred, so they load only when tool search finds them */
const TRACK_TOOLS_MAX_CHARS = 9_000

describe("the sources-a tools", () => {
  it("are stripe_overview, email_delivery and site_traffic, all behind tool search and read only", () => {
    expect(TOOLS.map((t) => [t.name, Boolean(t.deferred)])).toEqual([
      ["stripe_overview", true],
      ["email_delivery", true],
      ["site_traffic", true],
    ])
    for (const tool of TOOLS) expect(JACK_TOOLS).toContain(tool)
    expect(TOOLS.some((t) => t.writes || t.web)).toBe(false)
  })

  it("stay within the track's size budget for tool definitions", () => {
    const size = TOOLS.reduce((n, tool) => n + JSON.stringify({ name: tool.name, description: tool.description, input_schema: z.toJSONSchema(tool.input) }).length, 0)
    expect(size).toBeLessThanOrEqual(TRACK_TOOLS_MAX_CHARS)
  })
})
