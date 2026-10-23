import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import { kindsForTool } from "@/server/jack/proposals/registry"
import { JACK_TOOLS } from "../index"
import { TOOLS } from "./automation"

/** What the automation track's kind adds to the propose_* tools' definitions, in characters (design §8; about 1,800 now) */
const TRACK_KINDS_MAX_CHARS = 3_000

describe("the automation track's tools", () => {
  it("adds no tool of its own: recurring.upsert goes on propose_recurring, behind tool search", () => {
    expect(TOOLS).toEqual([])
    expect(kindsForTool("propose_recurring").map((k) => k.kind)).toEqual(["recurring.upsert"])
    const tool = JACK_TOOLS.find((t) => t.name === "propose_recurring")
    expect(tool?.deferred).toBe(true)
    expect(tool?.description).toMatch(/recurring\.upsert: /)
  })

  it("keeps the kind's definition small", () => {
    const [kind] = kindsForTool("propose_recurring")
    expect(kind.description.length + JSON.stringify(z.toJSONSchema(kind.schema)).length).toBeLessThanOrEqual(TRACK_KINDS_MAX_CHARS)
  })
})
