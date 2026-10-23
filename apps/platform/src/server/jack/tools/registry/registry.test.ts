import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { AnyJackTool } from "../types"

// The core tools are imported for real; nothing touches a database
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

const fakeTool = (name: string): AnyJackTool => ({
  name,
  description: "A test tool",
  input: z.object({}),
  run: async () => ({ forModel: "{}", label: "Ran it" }),
})

afterEach(async () => {
  const { SLOT_TRACKS } = await import("@/lib/slots")
  for (const track of SLOT_TRACKS) vi.doUnmock(`./${track}`)
  vi.resetModules()
})

describe("the tool slots", () => {
  it("send the tracks' tools after the core tools, in track order", async () => {
    // Every slot empty but the two below, so the tracks' real tools don't change what's checked
    const { SLOT_TRACKS } = await import("@/lib/slots")
    for (const track of SLOT_TRACKS) vi.doMock(`./${track}`, () => ({ TOOLS: [] }))
    vi.doMock("./sponsors-meetings", () => ({ TOOLS: [fakeTool("draft_text")] }))
    vi.doMock("./groundwork", () => ({ TOOLS: [fakeTool("room_files")] }))
    const { CORE_JACK_TOOLS, JACK_TOOLS, findJackTool } = await import("../index")
    // Only the mocked ones: the tracks' real tools sit among them
    expect(JACK_TOOLS.slice(CORE_JACK_TOOLS.length).map((t) => t.name).filter((name) => ["room_files", "draft_text"].includes(name))).toEqual(["room_files", "draft_text"])
    expect(JACK_TOOLS.slice(0, CORE_JACK_TOOLS.length)).toEqual(CORE_JACK_TOOLS)
    expect(findJackTool("draft_text")?.description).toBe("A test tool")
  })

  it("are listed by track too, for per-track checks", async () => {
    vi.doMock("./memory", () => ({ TOOLS: [fakeTool("knowledge")] }))
    const { SLOT_TOOLS, TOOL_SLOTS } = await import("./index")
    const { SLOT_TRACKS } = await import("@/lib/slots")
    expect(Object.keys(TOOL_SLOTS).sort()).toEqual([...SLOT_TRACKS].sort())
    expect(TOOL_SLOTS.memory.map((t) => t.name)).toEqual(["knowledge"])
    expect(SLOT_TRACKS.flatMap((track) => TOOL_SLOTS[track])).toEqual(SLOT_TOOLS)
  })

  it("throw at load when two tracks register the same name", async () => {
    vi.doMock("./memory", () => ({ TOOLS: [fakeTool("knowledge")] }))
    vi.doMock("./sponsors-meetings", () => ({ TOOLS: [fakeTool("knowledge")] }))
    await expect(import("./index")).rejects.toThrow('Duplicate Jack tool "knowledge": registered by memory and sponsors-meetings')
  })

  it("throw at load when a track reuses a core tool's name", async () => {
    vi.doMock("./memory", () => ({ TOOLS: [fakeTool("run_sql")] }))
    await expect(import("../index")).rejects.toThrow(`Duplicate Jack tool "run_sql"`)
  })
})
