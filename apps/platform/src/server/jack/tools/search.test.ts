import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

// search and read run against stand-in sources; the registry itself is real (its sources are mocked below)
const fake = vi.hoisted(() => ({ search: vi.fn(), read: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/search/search", () => ({ search: fake.search }))
vi.mock("@/server/jack/search/registry", () => ({
  SEARCH_SOURCES: [
    { key: "knowledge", description: "knowledge entries", byDefault: true, readers: [] },
    { key: "rooms", description: "room messages", byDefault: true, readers: [] },
  ],
  SEARCH_READERS: [
    { type: "knowledge", description: "a knowledge entry", read: fake.read },
    { type: "site_page", description: "a public page", read: fake.read },
  ],
  findReader: (type: string) => (["knowledge", "site_page"].includes(type) ? { type, read: fake.read } : undefined),
}))

import { readTool, searchTool } from "./search"

const ctx = { roomId: "room-1", actor: { userId: "officer-1", displayName: "Gray" } }

beforeEach(() => {
  fake.search.mockResolvedValue({ hits: [], outcomes: [] })
})

describe("search", () => {
  it("builds its source filter from the registry and validates it", () => {
    const schema = z.toJSONSchema(searchTool.input) as unknown as { properties: { sources: { items: { enum: string[] }; description: string } } }
    expect(schema.properties.sources.items.enum).toEqual(["knowledge", "rooms"])
    expect(schema.properties.sources.description).toContain("knowledge: knowledge entries")
    expect(searchTool.input.safeParse({ query: "x", sources: ["discord"] }).success).toBe(false)
    expect(searchTool.input.parse({ query: "  budget " })).toEqual({ query: "budget", includeJackReplies: false, limit: 10 })
  })

  it("returns each hit's type and id for read, its link, Central date and snippet, and shows them as links", async () => {
    fake.search.mockResolvedValue({
      hits: [{ source: "knowledge", type: "knowledge", id: "k1", title: "Sponsor tiers", url: "/admin/knowledge?entry=k1", snippet: "Gold tier gets a logo", date: "2026-10-19T23:00:00.000Z", meta: { ageDays: 3 }, rank: 0.5 }],
      outcomes: [
        { source: "knowledge", status: "searched", hits: 1 },
        { source: "teams", status: "unavailable", reason: "Teams isn't connected." },
      ],
    })
    const result = await searchTool.run(searchTool.input.parse({ query: "sponsor tiers", sources: ["knowledge"] }), ctx)
    expect(fake.search).toHaveBeenCalledWith({ query: "sponsor tiers", sources: ["knowledge"], limit: 10, includeJackReplies: false, signal: undefined })
    expect(JSON.parse(result.forModel)).toEqual({
      query: "sponsor tiers",
      searched: ["knowledge"],
      notSearched: ["teams: Teams isn't connected."],
      results: [{ type: "knowledge", id: "k1", title: "Sponsor tiers", url: "/admin/knowledge?entry=k1", date: "Mon 2026-10-19 18:00 CT", snippet: "Gold tier gets a logo", ageDays: 3 }],
    })
    expect(result.label).toBe("Searched for “sponsor tiers” (1 result)")
    expect(result.displays).toEqual([
      { kind: "links", items: [{ title: "Sponsor tiers", url: "/admin/knowledge?entry=k1", meta: "Knowledge · Oct 19, 2026", snippet: "Gold tier gets a logo" }], caption: "Not searched: teams: Teams isn't connected." },
    ])
  })

  it("says how to search again when nothing matched", async () => {
    const result = await searchTool.run(searchTool.input.parse({ query: "zeppelin" }), ctx)
    expect(JSON.parse(result.forModel).note).toMatch(/Nothing matched/)
    expect(result.displays).toEqual([{ kind: "note", text: "Nothing matched “zeppelin”." }])
  })
})

describe("read", () => {
  const long = ["# Rules", "Intro.", "## Points", "P".repeat(900), "## Penalties", "Q".repeat(900)].join("\n\n")

  beforeEach(() => {
    fake.read.mockResolvedValue({ ok: true, doc: { type: "knowledge", id: "k1", title: "LSC rules", url: "/admin/knowledge?entry=k1", date: null, meta: { versionId: "v1" }, text: long } })
  })

  it("returns a page with the next offset, the total and an outline", async () => {
    const result = await readTool.run(readTool.input.parse({ type: "knowledge", id: "k1", maxChars: 1_000 }), ctx)
    const body = JSON.parse(result.forModel)
    expect(body).toMatchObject({ type: "knowledge", id: "k1", title: "LSC rules", versionId: "v1", total: long.length, offset: 0 })
    expect(body.nextOffset).toBeGreaterThan(0)
    expect(body.text.length).toBeLessThanOrEqual(1_000)
    expect(body.outline.map((h: { heading: string }) => h.heading)).toEqual(["Rules", "Points", "Penalties"])
    expect(result.label).toMatch(/^Read “LSC rules” \(characters 1–\d+ of 1,8\d\d\)$/)

    const next = JSON.parse((await readTool.run(readTool.input.parse({ type: "knowledge", id: "k1", offset: body.nextOffset, maxChars: 1_000 }), ctx)).forModel)
    expect(body.text + next.text).toBe(long.slice(0, body.text.length + next.text.length))
  })

  it("leaves the outline out of a text that fits on one page", async () => {
    fake.read.mockResolvedValue({ ok: true, doc: { type: "knowledge", id: "k2", title: "Short", url: "/x", date: null, meta: {}, text: "# One\nTwo" } })
    const body = JSON.parse((await readTool.run(readTool.input.parse({ type: "knowledge", id: "k2" }), ctx)).forModel)
    expect(body).toMatchObject({ offset: 0, nextOffset: null, text: "# One\nTwo" })
    expect(body.outline).toBeUndefined()
  })

  it("returns only the passages that match a query", async () => {
    const result = await readTool.run(readTool.input.parse({ type: "knowledge", id: "k1", query: "penalties" }), ctx)
    const body = JSON.parse(result.forModel)
    expect(body.passages).toEqual([{ offset: long.indexOf("## Penalties"), text: "## Penalties" }])
    expect(body.matched).toBe(1)
    expect(result.label).toBe("Read “LSC rules” (1 matching passage)")
  })

  it("gives the model the reader's error to act on", async () => {
    fake.read.mockResolvedValue({ ok: false, error: "/admin isn't readable: the admin console, the API, accounts and sign-in pages are off-limits." })
    const result = await readTool.run(readTool.input.parse({ type: "site_page", id: "/admin" }), ctx)
    expect(result).toMatchObject({ isError: true, forModel: expect.stringContaining("off-limits"), label: "Couldn't read that site page" })
  })

  it("takes only registered types, and bounded sizes", () => {
    expect(readTool.input.safeParse({ type: "discord", id: "x" }).success).toBe(false)
    expect(readTool.input.safeParse({ type: "knowledge", id: "x", maxChars: 100_000 }).success).toBe(false)
    expect(readTool.input.parse({ type: "knowledge", id: "x" })).toEqual({ type: "knowledge", id: "x", offset: 0, maxChars: 15_000 })
  })
})
