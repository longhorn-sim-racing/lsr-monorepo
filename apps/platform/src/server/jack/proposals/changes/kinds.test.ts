import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

// The real tools and kinds are loaded; nothing touches a database
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import { toolDefinitions } from "../../model-loop"
import { findJackTool } from "../../tools"
import { IMPORT_TARGETS } from "../import-targets"
import { IMPORT_TARGETS as CHANGES_TARGETS } from "../import-targets/changes"
import { KINDS } from "../kinds/changes"
import { findProposalKind } from "../registry"

/** The most the changes track's kinds may add to the cached prompt (their lines in the propose_* tools and their fields), in characters (design §8) */
const TRACK_KINDS_MAX_CHARS = 13_500

describe("the changes track's proposal kinds", () => {
  it("are registered on the tools design §7.1 gives them", () => {
    expect(KINDS.map((k) => [k.kind, k.tool, k.permission, Boolean(k.destructive)])).toEqual([
      ["event.update", "propose_change", "officer", false],
      ["news.create", "propose_content", "officer", false],
      ["news.update", "propose_content", "officer", false],
      ["notification.send", "propose_message", "officer", true],
      ["results.import", "propose_import", "officer", false],
      ["attendance.checkin", "propose_import", "officer", false],
      ["import.rows", "propose_import", "officer", false],
    ])
    for (const kind of KINDS) expect(findProposalKind(kind.kind)).toBe(kind)
  })

  it("make their propose_* tools appear, each kind listed with what it does", () => {
    const listed = (tool: string) => (findJackTool(tool)?.description.match(/^- [a-z_.]+:/gm) ?? []).map((line) => line.slice(2, -1))
    expect(listed("propose_change")).toEqual(expect.arrayContaining(["page.update", "event.update"]))
    expect(listed("propose_content")).toEqual(["news.create", "news.update"])
    expect(listed("propose_message")).toEqual(["notification.send"])
    expect(listed("propose_import")).toEqual(["results.import", "attendance.checkin", "import.rows"])
    // Always loaded: the main propose tools aren't behind tool search
    for (const tool of ["propose_change", "propose_content", "propose_message", "propose_import"]) expect(findJackTool(tool)?.deferred).toBeUndefined()
    const [definition] = toolDefinitions([findJackTool("propose_import")!])
    expect(definition.input_schema.type).toBe("object")
  })

  it("register the LSC applications import target, which import.rows lists", () => {
    expect(CHANGES_TARGETS.map((t) => t.target)).toEqual(["lsc_application"])
    expect(IMPORT_TARGETS.map((t) => t.target)).toContain("lsc_application")
    expect(findProposalKind("import.rows")?.description).toContain("lsc_application (LSC entry forms; columns email, eid, name, discord*, experience, equipment*, canCommit, school, notes, season)")
  })

  it("stay within the track's size budget", () => {
    const size = KINDS.reduce((n, kind) => n + kind.description.length + JSON.stringify(z.toJSONSchema(kind.schema, { io: "input", unrepresentable: "any" })).length, 0)
    expect(size).toBeLessThanOrEqual(TRACK_KINDS_MAX_CHARS)
  })
})
