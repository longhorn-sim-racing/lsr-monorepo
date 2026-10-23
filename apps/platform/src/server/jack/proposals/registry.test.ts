import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { PROPOSE_TOOLS, type AnyImportTarget, type AnyProposalKind, type ProposeToolName } from "./types"

const fakeKind = (kind: string, tool: ProposeToolName = "propose_change"): AnyProposalKind => ({
  kind,
  tool,
  description: `Proposes ${kind}`,
  schema: z.object({}),
  permission: "officer",
  prepare: async () => ({ before: null, view: { title: kind, summary: "", diff: [] } }),
  checkStale: async () => null,
  apply: async () => ({ summary: "Done" }),
})

const fakeTarget = (target: string): AnyImportTarget => ({
  target,
  label: target,
  columns: [{ key: "name", label: "Name", required: true }],
  validateRow: async (row) => ({ ok: true, value: row, label: row.name ?? "" }),
  applyRows: async (rows) => ({ summary: `Imported ${rows.length}`, appliedRows: rows.map((r) => r.rowId) }),
})

afterEach(() => {
  vi.doUnmock("./kinds/changes")
  vi.doUnmock("./kinds/discord-post")
  vi.doUnmock("./kinds/sponsors-meetings")
  vi.doUnmock("./import-targets/changes")
  vi.doUnmock("./import-targets/sponsors-meetings")
  vi.resetModules()
})

describe("the proposal kind registry", () => {
  it("loads with unique kinds, and finds nothing it doesn't know", async () => {
    const { PROPOSAL_KINDS, findProposalKind } = await import("./registry")
    expect(new Set(PROPOSAL_KINDS.map((k) => k.kind)).size).toBe(PROPOSAL_KINDS.length)
    for (const kind of PROPOSAL_KINDS) {
      expect(PROPOSE_TOOLS, kind.kind).toContain(kind.tool)
      expect(kind.description.length, kind.kind).toBeGreaterThan(20)
    }
    expect(findProposalKind("nope.nothing")).toBeUndefined()
  })

  it("joins the tracks' kinds in track order, finds them by key, and groups them by tool", async () => {
    vi.doMock("./kinds/discord-post", () => ({ KINDS: [fakeKind("discord.post", "propose_discord")] }))
    vi.doMock("./kinds/sponsors-meetings", () => ({ KINDS: [fakeKind("action_item.update")] }))
    vi.doMock("./kinds/changes", () => ({ KINDS: [fakeKind("event.update"), fakeKind("news.create", "propose_content")] }))
    const { PROPOSAL_KINDS, findProposalKind, kindsForTool } = await import("./registry")
    // Track order (changes, then discord-post, then sponsors-meetings), not import order
    expect(PROPOSAL_KINDS.map((k) => k.kind)).toEqual(["event.update", "news.create", "discord.post", "action_item.update"])
    expect(findProposalKind("discord.post")?.tool).toBe("propose_discord")
    // Two tracks' kinds in one tool, neither track editing the other's files
    expect(kindsForTool("propose_change").map((k) => k.kind)).toEqual(["event.update", "action_item.update"])
    expect(kindsForTool("propose_recurring")).toEqual([])
  })

  it("throws at load when two tracks register the same kind", async () => {
    vi.doMock("./kinds/changes", () => ({ KINDS: [fakeKind("event.update")] }))
    vi.doMock("./kinds/discord-post", () => ({ KINDS: [fakeKind("event.update")] }))
    await expect(import("./registry")).rejects.toThrow('Duplicate proposal kind "event.update": registered by changes and discord-post')
  })

  it("lets a kind use the import targets, even when the kind's file loads first", async () => {
    vi.doMock("./import-targets/sponsors-meetings", () => ({ IMPORT_TARGETS: [fakeTarget("action_item")] }))
    // The import.rows shape: the kind's file imports the targets' registry, never the kinds'
    vi.doMock("./kinds/changes", async () => {
      const { findImportTarget } = await import("./import-targets")
      const importRows: AnyProposalKind = { ...fakeKind("import.rows", "propose_import"), apply: async () => ({ summary: `Into ${findImportTarget("action_item")?.label}` }) }
      return { KINDS: [importRows] }
    })
    await import("./kinds/changes")
    const { findProposalKind } = await import("./registry")
    const kind = findProposalKind("import.rows")!
    expect(await kind.apply({}, { officer: { userId: "u1", displayName: "Gray" }, proposalId: "p1", roomId: "r1", idempotencyKey: "proposal:p1" })).toEqual({ summary: "Into action_item" })
  })

  it("has no kind file that imports the kinds registry (an import cycle)", () => {
    const dir = join(__dirname, "kinds")
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), "utf8")
      expect(source, file).not.toMatch(/from\s+["'](\.\.\/registry|@\/server\/jack\/proposals\/registry)["']/)
    }
  })
})

describe("the import target registry", () => {
  it("loads with unique targets, and finds them by key", async () => {
    vi.doMock("./import-targets/changes", () => ({ IMPORT_TARGETS: [fakeTarget("lsc_application")] }))
    const { IMPORT_TARGETS, findImportTarget } = await import("./import-targets")
    expect(new Set(IMPORT_TARGETS.map((t) => t.target)).size).toBe(IMPORT_TARGETS.length)
    expect(findImportTarget("lsc_application")?.label).toBe("lsc_application")
    expect(findImportTarget("nope")).toBeUndefined()
  })

  it("throws at load when two tracks register the same target", async () => {
    vi.doMock("./import-targets/changes", () => ({ IMPORT_TARGETS: [fakeTarget("action_item")] }))
    vi.doMock("./import-targets/sponsors-meetings", () => ({ IMPORT_TARGETS: [fakeTarget("action_item")] }))
    await expect(import("./import-targets")).rejects.toThrow('Duplicate import target "action_item": registered by changes and sponsors-meetings')
  })
})
