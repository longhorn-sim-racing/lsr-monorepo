import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import { kindsForTool } from "@/server/jack/proposals/registry"
import { findImportTarget } from "@/server/jack/proposals/import-targets"
import { JACK_TOOLS } from "../index"
import { TOOLS } from "./sponsors-meetings"

/** The most the sponsors-meetings track's own tool definitions may add to the cached prompt, in characters (design §8; about 4,600 now) */
const TRACK_TOOLS_MAX_CHARS = 6_000
/** And what its four kinds add to the propose_* tools' definitions (about 7,000 now) */
const TRACK_KINDS_MAX_CHARS = 8_000

const size = (tool: { name: string; description: string; input: z.ZodType }) => JSON.stringify({ name: tool.name, description: tool.description, input_schema: z.toJSONSchema(tool.input) }).length

describe("the sponsors-meetings tools", () => {
  it("are draft_text (always loaded), then sponsors_list and meetings_list (behind tool search)", () => {
    expect(TOOLS.map((t) => [t.name, Boolean(t.deferred)])).toEqual([
      ["draft_text", false],
      ["sponsors_list", true],
      ["meetings_list", true],
    ])
    for (const tool of TOOLS) expect(JACK_TOOLS).toContain(tool)
    expect(TOOLS.some((t) => t.writes)).toBe(false)
  })

  it("stay within the track's size budget for tool definitions", () => {
    expect(TOOLS.reduce((n, tool) => n + size(tool), 0)).toBeLessThanOrEqual(TRACK_TOOLS_MAX_CHARS)
  })

  it("put the meeting and prospect kinds on propose_meeting (deferred) and action items on propose_change", () => {
    expect(kindsForTool("propose_meeting").map((k) => k.kind)).toEqual(expect.arrayContaining(["meeting.record", "prospect.upsert", "prospect.activity"]))
    expect(kindsForTool("propose_change").map((k) => k.kind)).toContain("action_item.update")
    const proposeMeeting = JACK_TOOLS.find((t) => t.name === "propose_meeting")
    expect(proposeMeeting?.deferred).toBe(true)
    expect(proposeMeeting?.description).toMatch(/meeting\.record: /)
  })

  it("keep the kinds' own definitions small", () => {
    const ours = ["meeting.record", "prospect.upsert", "prospect.activity", "action_item.update"]
    const kinds = [...kindsForTool("propose_meeting"), ...kindsForTool("propose_change")].filter((k) => ours.includes(k.kind))
    expect(kinds).toHaveLength(4)
    const total = kinds.reduce((n, k) => n + k.description.length + JSON.stringify(z.toJSONSchema(k.schema)).length, 0)
    expect(total).toBeLessThanOrEqual(TRACK_KINDS_MAX_CHARS)
  })

  it("register the prospects and action items import targets", () => {
    expect(findImportTarget("sponsor_prospects")?.label).toBe("Sponsor prospects")
    expect(findImportTarget("action_items")?.label).toBe("Action items")
  })
})
