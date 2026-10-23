import { afterEach, describe, expect, it, vi } from "vitest"
import { memoryDocumentStore } from "../documents/testing"
import { mountFakes } from "../fakes/testing"
import { GRAPH_FAKE } from "../microsoft/fake/fixtures"
import { microsoftGraphFake } from "../microsoft/fake/handlers"
import { GraphApiError, graphClient } from "../microsoft/graph"
import { namesFromGraphPath, syncSharePoint, type SharePointCursor, type SharePointSyncOptions } from "./sync"

afterEach(() => {
  vi.unstubAllGlobals()
})

const id = (itemId: string) => `${GRAPH_FAKE.driveId}!${itemId}`

function setup() {
  const fakes = mountFakes([microsoftGraphFake])
  const store = memoryDocumentStore("sharepoint")
  const run = (cursor: SharePointCursor | null | undefined, extra: Partial<SharePointSyncOptions> = {}) =>
    syncSharePoint({
      graph: graphClient({ tenantId: GRAPH_FAKE.tenantId, clientId: GRAPH_FAKE.clientId, clientSecret: GRAPH_FAKE.clientSecret }, { retryDelayMs: 0 }),
      driveId: GRAPH_FAKE.driveId,
      store,
      cursor,
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      ...extra,
    })
  const hook = (path: string, body: unknown) => fetch(`${fakes.origin}/microsoft-graph/_fake/${path}`, { method: "POST", body: JSON.stringify(body) })
  return { fakes, store, run, hook }
}

describe("the first SharePoint sync", () => {
  it("enumerates the library and reads each file's text, with its folder", async () => {
    const { store, run } = setup()
    const { cursor, counts, more } = await run(null)
    expect(more).toBe(false)
    expect(cursor.deltaLink).toMatch(/\/root\/delta\?token=/)
    expect(cursor.lastFullAt).toBeTruthy()
    expect(counts).toMatchObject({ indexed: 5, folders: 3 })

    expect(store.rows.get(id("sp-budget"))).toMatchObject({ name: "Budget FA26.xlsx", path: "/General", driveId: GRAPH_FAKE.driveId, textStatus: "ok", webUrl: "https://fixture.sharepoint.com/sites/lsr/Shared%20Documents/General/Budget%20FA26.xlsx" })
    expect(store.rows.get(id("sp-budget"))!.text).toContain("Showcase,400")
    expect(store.rows.get(id("sp-packet"))!.text).toContain("Fixture Motors gets the Gold slot")
    // A "Transcripts" folder is just more documents, speaker-tagged
    expect(store.rows.get(id("sp-transcript"))).toMatchObject({ path: "/Transcripts", text: "[0:02] Fixture Officer A: Recruiting closes Friday.\n[0:06] Fixture Officer B: I'll post the reminder." })
    expect(store.rows.get(id("sp-rules"))).toMatchObject({ path: "/", textStatus: "ok" })
    expect(store.rows.get(id("sp-logo"))).toMatchObject({ textStatus: "unsupported", text: null })
    expect(JSON.stringify(cursor)).not.toMatch(/fixture\.graph\.|client-secret/)
  })

  it("pages through the delta, saving where it got to, and resumes after the deadline", async () => {
    const { store, run, hook } = setup()
    await hook("config", { pageSize: 2 })
    const saved: SharePointCursor[] = []
    const stopped = await run(null, { deadline: Date.now() - 1, saveCursor: async (c) => void saved.push(structuredClone(c)) })
    expect(stopped.more).toBe(true)
    expect(stopped.cursor.enumeration).toBeTruthy()
    const done = await run(stopped.cursor, { saveCursor: async (c) => void saved.push(structuredClone(c)) })
    expect(done.more).toBe(false)
    expect(saved.some((c) => c.enumeration?.nextLink)).toBe(true)
    expect(store.live()).toHaveLength(5)
  })
})

describe("later SharePoint syncs", () => {
  it("follow the delta link: new and changed files are read, deleted ones removed", async () => {
    const { store, run, hook } = setup()
    const first = await run(null)
    await hook("mutate", { op: "upload", id: "sp-new", name: "Notes.txt", parentId: "sp-general", text: "Fresh notes." })
    await hook("mutate", { op: "upload", id: "sp-rules", text: "# Rules draft (fixture)\n\nTwo-second penalties now." })
    await hook("mutate", { op: "delete-item", id: "sp-packet" })
    const second = await run(first.cursor)
    expect(second.counts).toMatchObject({ indexed: 2, removed: 1 })
    expect(store.rows.get(id("sp-new"))).toMatchObject({ path: "/General", text: "Fresh notes." })
    expect(store.rows.get(id("sp-rules"))!.text).toContain("Two-second penalties")
    expect(store.rows.get(id("sp-packet"))).toMatchObject({ text: null, deletedAt: expect.any(Date) })
    expect(second.cursor.deltaLink).not.toBe(first.cursor.deltaLink)
  })

  it("starts a full enumeration when Graph answers 410", async () => {
    const { run, hook } = setup()
    const first = await run(null)
    await hook("config", { resync: true })
    const second = await run(first.cursor)
    expect(second.cursor.lastFullAt).not.toBe(first.cursor.lastFullAt)
    expect(second.counts.unchanged).toBe(5)
  })

  it("re-enumerates weekly, fixing paths under renamed folders and removing what's gone", async () => {
    const { store, run, hook } = setup()
    const first = await run(null)
    await hook("mutate", { op: "rename-item", id: "sp-general", name: "General Channel" })
    await store.save({ externalId: id("ghost"), name: "Ghost.txt", path: "/", mimeType: "text/plain", webUrl: "", modifiedAt: new Date(), sizeBytes: 1, version: "1" }, { text: "boo", textStatus: "ok" }, new Date(Date.now() - 86_400_000))
    const later = await run({ ...first.cursor, lastFullAt: new Date(Date.now() - 8 * 86_400_000).toISOString() })
    expect(store.rows.get(id("sp-budget"))!.path).toBe("/General Channel")
    expect(store.rows.get(id("ghost"))).toMatchObject({ text: null, deletedAt: expect.any(Date) })
    expect(later.counts.removed).toBe(1)
  })

  it("starts over when MS_DRIVE_ID names another library", async () => {
    const { run } = setup()
    const first = await run(null)
    const moved = await run({ ...first.cursor, driveId: "b!another" })
    expect(moved.cursor.driveId).toBe(GRAPH_FAKE.driveId)
    expect(moved.counts.unchanged).toBe(5)
  })
})

describe("one file never stops the SharePoint sync", () => {
  it("removes a file whose folder was deleted after the delta listed it, and goes on", async () => {
    const { store, run, hook } = setup()
    const first = await run(null)
    await hook("mutate", { op: "upload", id: "sp-budget", text: "Category,Amount\nShowcase,450" })
    await hook("mutate", { op: "upload", id: "sp-new", name: "Notes.txt", parentId: "sp-root", text: "Fresh notes." })
    // The parent GET answers 404: the folder went between the delta page and the lookup
    const real = graphClient({ tenantId: GRAPH_FAKE.tenantId, clientId: GRAPH_FAKE.clientId, clientSecret: GRAPH_FAKE.clientSecret }, { retryDelayMs: 0 })
    const graph = {
      ...real,
      get: <T>(path: string, options?: { signal?: AbortSignal }) => (path.includes("/items/sp-general?") ? Promise.reject(new GraphApiError(404, "itemNotFound", path)) : real.get<T>(path, options)),
    }
    const second = await run(first.cursor, { graph })
    expect(second.more).toBe(false)
    expect(store.rows.get(id("sp-budget"))).toMatchObject({ text: null, deletedAt: expect.any(Date) })
    expect(store.rows.get(id("sp-new"))).toMatchObject({ text: "Fresh notes.", path: "/" })
    expect(second.cursor.deltaLink).not.toBe(first.cursor.deltaLink)
  })

  it("gives a file in a folder it may not read no path, instead of failing", async () => {
    const { store, run, hook } = setup()
    const first = await run(null)
    await hook("mutate", { op: "upload", id: "sp-minutes", name: "Minutes.txt", parentId: "sp-general", mimeType: "text/plain", text: "Minutes (fixture)." })
    const real = graphClient({ tenantId: GRAPH_FAKE.tenantId, clientId: GRAPH_FAKE.clientId, clientSecret: GRAPH_FAKE.clientSecret }, { retryDelayMs: 0 })
    const graph = { ...real, get: <T>(path: string, options?: { signal?: AbortSignal }) => (path.includes("/items/sp-general?") ? Promise.reject(new GraphApiError(403, "accessDenied", path)) : real.get<T>(path, options)) }
    await run(first.cursor, { graph })
    expect(store.rows.get(id("sp-minutes"))).toMatchObject({ path: "/", text: "Minutes (fixture).", deletedAt: null })
  })

  it("keeps a file whose text the database refuses, without its text", async () => {
    const { store, run } = setup()
    const save = store.save.bind(store)
    store.save = async (meta, text, at) => {
      if (meta.externalId === id("sp-packet") && text.text !== null) throw new Error("refused")
      return save(meta, text, at)
    }
    const { more } = await run(null)
    expect(more).toBe(false)
    expect(store.rows.get(id("sp-packet"))).toMatchObject({ text: null, textStatus: "error", deletedAt: null })
    expect(store.live()).toHaveLength(5)
  })

  it("reads a file again at the weekly enumeration when its last read failed", async () => {
    const { store, run } = setup()
    const first = await run(null)
    const row = store.rows.get(id("sp-rules"))!
    store.rows.set(id("sp-rules"), { ...row, text: null, textStatus: "error" })
    const later = await run({ ...first.cursor, lastFullAt: new Date(Date.now() - 8 * 86_400_000).toISOString() })
    expect(later.counts).toMatchObject({ indexed: 1, unchanged: 4 })
    expect(store.rows.get(id("sp-rules"))).toMatchObject({ textStatus: "ok", text: expect.stringContaining("Rules") })
  })
})

describe("namesFromGraphPath", () => {
  it("reads a parent's path after root:, decoded", () => {
    expect(namesFromGraphPath("/drives/b!x/root:/Sponsors/Fall%202026")).toEqual(["Sponsors", "Fall 2026"])
    expect(namesFromGraphPath("/drive/root:")).toEqual([])
    expect(namesFromGraphPath(undefined)).toEqual([])
  })
})
