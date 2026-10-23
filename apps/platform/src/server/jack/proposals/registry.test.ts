import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { AnyImportTarget, AnyProposalKind } from "./types"

const fakeKind = (kind: string): AnyProposalKind => ({
  kind,
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
  vi.doUnmock("./import-targets/changes")
  vi.doUnmock("./import-targets/sponsors-meetings")
  vi.resetModules()
})

describe("the proposal registry", () => {
  it("loads with unique keys, and finds nothing it doesn't know", async () => {
    const { PROPOSAL_KINDS, IMPORT_TARGETS, findProposalKind, findImportTarget } = await import("./registry")
    expect(new Set(PROPOSAL_KINDS.map((k) => k.kind)).size).toBe(PROPOSAL_KINDS.length)
    expect(new Set(IMPORT_TARGETS.map((t) => t.target)).size).toBe(IMPORT_TARGETS.length)
    expect(findProposalKind("nope.nothing")).toBeUndefined()
    expect(findImportTarget("nope")).toBeUndefined()
  })

  it("joins the tracks' kinds and finds them by key", async () => {
    vi.doMock("./kinds/discord-post", () => ({ KINDS: [fakeKind("discord.post")] }))
    vi.doMock("./kinds/changes", () => ({ KINDS: [fakeKind("event.update")] }))
    const { PROPOSAL_KINDS, findProposalKind } = await import("./registry")
    // Track order (changes before discord-post), not import order
    expect(PROPOSAL_KINDS.map((k) => k.kind)).toEqual(["event.update", "discord.post"])
    expect(findProposalKind("discord.post")?.kind).toBe("discord.post")
  })

  it("throws at load when two tracks register the same kind", async () => {
    vi.doMock("./kinds/changes", () => ({ KINDS: [fakeKind("event.update")] }))
    vi.doMock("./kinds/discord-post", () => ({ KINDS: [fakeKind("event.update")] }))
    await expect(import("./registry")).rejects.toThrow('Duplicate proposal kind "event.update": registered by changes and discord-post')
  })

  it("throws at load when two tracks register the same import target", async () => {
    vi.doMock("./import-targets/changes", () => ({ IMPORT_TARGETS: [fakeTarget("action_item")] }))
    vi.doMock("./import-targets/sponsors-meetings", () => ({ IMPORT_TARGETS: [fakeTarget("action_item")] }))
    await expect(import("./registry")).rejects.toThrow('Duplicate import target "action_item": registered by changes and sponsors-meetings')
  })
})
