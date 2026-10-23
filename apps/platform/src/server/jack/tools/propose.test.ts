import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const service = vi.hoisted(() => ({ createProposal: vi.fn() }))
vi.mock("@/server/jack/proposals/service", () => service)
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import type { AnyProposalKind, ProposeToolName } from "@/server/jack/proposals/types"
import { toolDefinitions } from "../model-loop"
import { proposeTool, proposeTools } from "./propose"
import type { JackToolContext } from "./types"

const kind = (key: string, schema: z.ZodType, extra: Partial<AnyProposalKind> = {}): AnyProposalKind => ({
  kind: key,
  tool: "propose_change",
  description: `${key}: changes things for the tests, with a long enough description`,
  schema,
  permission: "officer",
  prepare: async () => ({ before: null, view: { title: key, summary: "", diff: [] } }),
  checkStale: async () => null,
  apply: async () => ({ summary: "Done" }),
  ...extra,
})

const eventUpdate = kind("event.update", z.object({ eventId: z.string(), title: z.string().optional() }))
const pageUpdate = kind(
  "page.update",
  z.object({ pageId: z.string(), title: z.string().optional() }).refine((p) => p.title !== undefined, "Give a title."),
  { permission: "admin" },
)
const ctx: JackToolContext = { roomId: "room-1", actor: { userId: "u1", displayName: "Ana" }, messageId: "reply-1" }

beforeEach(() => {
  service.createProposal.mockResolvedValue({
    ok: true,
    superseded: ["old-1"],
    proposal: { kind: "proposal", proposalId: "p1", proposalKind: "page.update", title: "Rename the page", summary: "Renames it.", preview: [{ label: "Title", before: "A", after: "B", format: "text" }] },
  })
})

describe("the propose_* tools", () => {
  it("leaves out a tool with no kinds, so the model is never offered an empty one", () => {
    expect(proposeTool("propose_recurring", [])).toBeNull()
    const kindsFor = (tool: ProposeToolName) => (tool === "propose_change" ? [eventUpdate] : [])
    expect(proposeTools(kindsFor).map((t) => t.name)).toEqual(["propose_change"])
  })

  it("takes a union of its kinds' payloads under `proposal`, so the model sees every kind's fields", () => {
    const tool = proposeTool("propose_change", [eventUpdate, pageUpdate])!
    const [definition] = toolDefinitions([tool])
    // The API takes only an object at the top of a tool's input schema
    expect(definition.input_schema.type).toBe("object")
    expect(definition.input_schema).not.toHaveProperty("oneOf")
    const members = (definition.input_schema.properties as Record<string, { oneOf: { properties: Record<string, unknown>; required: string[] }[] }>).proposal.oneOf
    expect(members.map((m) => m.properties.kind)).toEqual([
      expect.objectContaining({ const: "event.update" }),
      expect.objectContaining({ const: "page.update" }),
    ])
    expect(Object.keys(members[0].properties)).toEqual(["eventId", "title", "kind"])
    expect(members[1].required).toEqual(["pageId", "kind"])
  })

  it("validates the payload against the kind it names, refinements included", () => {
    const tool = proposeTool("propose_change", [eventUpdate, pageUpdate])!
    expect(tool.input.safeParse({ proposal: { kind: "event.update", eventId: "e1" } }).success).toBe(true)
    expect(tool.input.safeParse({ proposal: { kind: "page.update", pageId: "p1" } }).success).toBe(false)
    expect(tool.input.safeParse({ proposal: { kind: "news.create", pageId: "p1" } }).success).toBe(false)
    expect(tool.input.safeParse({ kind: "event.update", eventId: "e1" }).success).toBe(false)
  })

  it("uses the kind's own object when it has just one, and says what each kind is for", () => {
    const tool = proposeTool("propose_change", [pageUpdate])!
    const [definition] = toolDefinitions([tool])
    const proposal = (definition.input_schema.properties as Record<string, Record<string, unknown>>).proposal
    expect(proposal.type).toBe("object")
    expect(proposal).not.toHaveProperty("oneOf")
    expect(tool.description).toMatch(/^Propose a change to something already on the site/)
    expect(tool.description).toMatch(/Nothing changes until an officer presses Apply/)
    expect(tool.description).toMatch(/Call it last in a reply/)
    expect(tool.description).toContain("- page.update: changes things for the tests, with a long enough description Only an admin can apply it.")
    expect(tool.writes).toBe(true)
  })

  it("defers the rarer tools", () => {
    expect(proposeTool("propose_discord", [{ ...eventUpdate, tool: "propose_discord" }])?.deferred).toBe(true)
    expect(proposeTool("propose_change", [eventUpdate])?.deferred).toBeUndefined()
  })

  it("refuses kinds it can't show the model", () => {
    expect(() => proposeTool("propose_change", [kind("bad.kind", z.string())])).toThrow(/must be a z.object/)
    expect(() => proposeTool("propose_change", [kind("bad.kind", z.object({ kind: z.string() }))])).toThrow(/can't have a field named "kind"/)
  })

  it("makes the proposal for the officer who asked, and shows its card", async () => {
    const tool = proposeTool("propose_change", [eventUpdate, pageUpdate])!
    const input = tool.input.parse({ proposal: { kind: "page.update", pageId: "p1", title: "B" } })
    const result = await tool.run(input, ctx)
    expect(service.createProposal).toHaveBeenCalledWith({ kind: "page.update", payload: { pageId: "p1", title: "B" }, roomId: "room-1", messageId: "reply-1", proposedFor: ctx.actor, signal: undefined }, undefined)
    expect(result.label).toBe("Proposed: Rename the page")
    expect(result.displays).toEqual([expect.objectContaining({ kind: "proposal", proposalId: "p1" })])
    expect(JSON.parse(result.forModel)).toMatchObject({ proposalId: "p1", status: "PENDING", replaced: ["old-1"], note: expect.stringMatching(/Nothing has changed/) })
    expect(result.isError).toBeUndefined()
  })

  it("hands the model back what was wrong, so it can fix it", async () => {
    service.createProposal.mockResolvedValue({ ok: false, error: "The edit: the find text isn't in the page's text." })
    const tool = proposeTool("propose_change", [pageUpdate])!
    const result = await tool.run(tool.input.parse({ proposal: { kind: "page.update", pageId: "p1", title: "B" } }), ctx)
    expect(result).toEqual({ forModel: "The edit: the find text isn't in the page's text.", label: "Proposal not made", isError: true })
  })
})

describe("the tools Jack gets", () => {
  it("include propose_change with page.update, after the core tools", async () => {
    const { findJackTool, JACK_TOOLS, CORE_JACK_TOOLS } = await import("./index")
    const tool = findJackTool("propose_change")
    expect(tool?.description).toContain("- page.update: change a content page")
    expect(JACK_TOOLS.indexOf(tool!)).toBeGreaterThanOrEqual(CORE_JACK_TOOLS.length)
    // Only tools with kinds are sent
    const { kindsForTool } = await import("@/server/jack/proposals/registry")
    const { PROPOSE_TOOLS } = await import("@/server/jack/proposals/types")
    for (const name of PROPOSE_TOOLS) expect(Boolean(findJackTool(name)), name).toBe(kindsForTool(name).length > 0)
  })
})
