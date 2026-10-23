import { beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn(), requireRole: vi.fn() }))
const service = vi.hoisted(() => ({
  createKnowledgeEntry: vi.fn(),
  updateKnowledgeEntry: vi.fn(),
  markKnowledgeReviewed: vi.fn(),
  setKnowledgeArchived: vi.fn(),
  deleteKnowledgeEntry: vi.fn(),
}))
const db = vi.hoisted(() => ({ user: { count: vi.fn() }, knowledgeEntryVersion: { findFirst: vi.fn() } }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/jack/knowledge/service", () => service)
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("next/cache", () => cache)

import {
  deleteKnowledgeEntryForGood,
  markKnowledgeEntryReviewed,
  restoreKnowledgeVersion,
  saveKnowledgeEntry,
  setKnowledgeEntryArchived,
  type KnowledgeFormInput,
} from "./actions"

const form = (overrides: Partial<KnowledgeFormInput> = {}): KnowledgeFormInput => ({
  title: "Dues policy",
  body: "No dues this semester.",
  tags: "dues, policy",
  sourceNote: "Dylan, exec meeting",
  sourceUrl: "",
  sourceDate: "2026-09-29",
  ownerId: "",
  ...overrides,
})

const entry = { id: "entry-1", title: "Dues policy" }

beforeEach(() => {
  vi.clearAllMocks()
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  guards.requireRole.mockRejectedValue(new Error("Requires one of the following roles: admin"))
  db.user.count.mockResolvedValue(1)
  service.createKnowledgeEntry.mockResolvedValue({ ok: true, changed: true, entry, versionId: "v1" })
  service.updateKnowledgeEntry.mockResolvedValue({ ok: true, changed: true, entry, versionId: "v2" })
  service.markKnowledgeReviewed.mockResolvedValue({ ok: true, changed: true, entry })
  service.setKnowledgeArchived.mockResolvedValue({ ok: true, changed: true, entry })
  service.deleteKnowledgeEntry.mockResolvedValue({ ok: true, title: "Dues policy" })
})

describe("who can do what", () => {
  it("needs an officer for every change", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("Requires one of the following roles: admin, officer"))
    for (const result of [
      await saveKnowledgeEntry(null, form()),
      await markKnowledgeEntryReviewed("entry-1", "v1"),
      await setKnowledgeEntryArchived("entry-1", true),
      await restoreKnowledgeVersion("entry-1", "v1", "v2"),
    ]) {
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/signed out or no longer an officer/) })
    }
    expect(Object.values(service).every((fn) => fn.mock.calls.length === 0)).toBe(true)
  })

  it("lets only admins delete for good", async () => {
    expect(await deleteKnowledgeEntryForGood("entry-1")).toMatchObject({ ok: false, error: expect.stringMatching(/Only admins/) })
    expect(service.deleteKnowledgeEntry).not.toHaveBeenCalled()

    guards.requireRole.mockResolvedValue({ id: "admin-1" })
    expect(await deleteKnowledgeEntryForGood("entry-1")).toEqual({ ok: true })
    expect(guards.requireRole).toHaveBeenCalledWith("admin")
    expect(service.deleteKnowledgeEntry).toHaveBeenCalledWith("entry-1", { userId: "admin-1", via: "admin" })
  })

  it("lets any officer review, archive and unarchive", async () => {
    expect(await markKnowledgeEntryReviewed("entry-1", "v2")).toEqual({ ok: true })
    // As of the version the page showed: a newer one is refused (the service's check)
    expect(service.markKnowledgeReviewed).toHaveBeenCalledWith("entry-1", { userId: "officer-1", via: "admin" }, { baseVersionId: "v2" })
    service.markKnowledgeReviewed.mockResolvedValueOnce({ ok: false, reason: "conflict", error: "“Dues policy” changed since you opened it." })
    expect(await markKnowledgeEntryReviewed("entry-1", "v1")).toEqual({ ok: false, error: "“Dues policy” changed since you opened it." })
    expect(await setKnowledgeEntryArchived("entry-1", false)).toEqual({ ok: true })
    expect(service.setKnowledgeArchived).toHaveBeenCalledWith("entry-1", false, { userId: "officer-1", via: "admin" })
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/knowledge/entry-1")
  })
})

describe("saveKnowledgeEntry", () => {
  it("creates an entry from the form, as the officer", async () => {
    expect(await saveKnowledgeEntry(null, form({ ownerId: "officer-2" }), { markReviewed: true })).toEqual({ ok: true, id: "entry-1" })
    const [fields, writer, options] = service.createKnowledgeEntry.mock.calls[0]
    expect(fields).toMatchObject({ title: "Dues policy", tags: ["dues", " policy"], sourceDate: new Date("2026-09-29T05:00:00Z"), ownerId: "officer-2", sourceUrl: "" })
    expect(writer).toEqual({ userId: "officer-1", via: "admin" })
    expect(options.reviewedAt).toBeInstanceOf(Date)
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/knowledge")
  })

  it("edits on the version the form was opened at", async () => {
    await saveKnowledgeEntry("entry-1", form({ sourceDate: "" }), { baseVersionId: "v1" })
    expect(service.updateKnowledgeEntry).toHaveBeenCalledWith("entry-1", expect.objectContaining({ sourceDate: null }), { userId: "officer-1", via: "admin" }, { baseVersionId: "v1", markReviewed: undefined, allowArchived: true })
  })

  it("sends only the fields an edit changed, so it can't undo another officer's owner or source", async () => {
    await saveKnowledgeEntry("entry-1", { body: "New text." }, { baseVersionId: "v1" })
    expect(service.updateKnowledgeEntry.mock.calls[0][1]).toEqual({ body: "New text." })

    await saveKnowledgeEntry("entry-1", { ownerId: "", sourceDate: "" }, { baseVersionId: "v1" })
    expect(service.updateKnowledgeEntry.mock.calls[1][1]).toEqual({ ownerId: null, sourceDate: null })
    // "No owner" needs no owner check
    expect(db.user.count).not.toHaveBeenCalled()
  })

  it("passes back duplicates and conflicts for the form to show", async () => {
    service.createKnowledgeEntry.mockResolvedValueOnce({ ok: false, reason: "duplicate", error: "There's already an entry like this", duplicates: [{ id: "d1", title: "Dues", score: 1, reason: "title", updatedAt: new Date() }] })
    expect(await saveKnowledgeEntry(null, form())).toEqual({ ok: false, error: "There's already an entry like this", duplicates: [{ id: "d1", title: "Dues" }] })

    await saveKnowledgeEntry(null, form(), { notDuplicateOf: ["d1"] })
    expect(service.createKnowledgeEntry.mock.calls[1][2]).toMatchObject({ notDuplicateOf: ["d1"] })

    service.updateKnowledgeEntry.mockResolvedValueOnce({ ok: false, reason: "conflict", error: "changed", current: {} })
    expect(await saveKnowledgeEntry("entry-1", form(), { baseVersionId: "v0" })).toMatchObject({ ok: false, conflict: true })
  })

  it("checks the date and the owner first", async () => {
    expect(await saveKnowledgeEntry(null, form({ sourceDate: "2026-02-30" }))).toMatchObject({ ok: false, error: expect.stringMatching(/isn't a date/) })
    db.user.count.mockResolvedValueOnce(0)
    expect(await saveKnowledgeEntry(null, form({ ownerId: "member-1" }))).toEqual({ ok: false, error: "The owner has to be an officer." })
    expect(service.createKnowledgeEntry).not.toHaveBeenCalled()
  })

  it("says so when saving fails unexpectedly", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {})
    service.createKnowledgeEntry.mockRejectedValueOnce(new Error("connection reset"))
    expect(await saveKnowledgeEntry(null, form())).toMatchObject({ ok: false, error: expect.stringMatching(/Couldn't save the entry/) })
  })
})

describe("restoreKnowledgeVersion", () => {
  it("saves an earlier version's text as the newest, on the current version", async () => {
    db.knowledgeEntryVersion.findFirst.mockResolvedValueOnce({ title: "Dues", body: "Old text", tags: ["dues"] })
    expect(await restoreKnowledgeVersion("entry-1", "v1", "v3")).toEqual({ ok: true })
    expect(db.knowledgeEntryVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "v1", entryId: "entry-1" } }))
    expect(service.updateKnowledgeEntry).toHaveBeenCalledWith("entry-1", { title: "Dues", body: "Old text", tags: ["dues"] }, { userId: "officer-1", via: "admin" }, { baseVersionId: "v3", allowArchived: true })

    db.knowledgeEntryVersion.findFirst.mockResolvedValueOnce(null)
    expect(await restoreKnowledgeVersion("entry-1", "gone", "v3")).toMatchObject({ ok: false, error: expect.stringMatching(/doesn't exist/) })
  })
})
