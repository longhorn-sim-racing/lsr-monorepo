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

afterEach(() => {
  vi.doUnmock("./groundwork")
  vi.doUnmock("./memory")
  vi.doUnmock("./sponsors-meetings")
  vi.resetModules()
})

describe("the tool slots", () => {
  it("send the tracks' tools after the core tools, in track order", async () => {
    vi.doMock("./sponsors-meetings", () => ({ TOOLS: [fakeTool("draft_text")] }))
    vi.doMock("./groundwork", () => ({ TOOLS: [fakeTool("room_files")] }))
    const { CORE_JACK_TOOLS, JACK_TOOLS, findJackTool } = await import("../index")
    expect(JACK_TOOLS.slice(CORE_JACK_TOOLS.length).map((t) => t.name)).toEqual(["room_files", "draft_text"])
    expect(JACK_TOOLS.slice(0, CORE_JACK_TOOLS.length)).toEqual(CORE_JACK_TOOLS)
    expect(findJackTool("draft_text")?.description).toBe("A test tool")
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
