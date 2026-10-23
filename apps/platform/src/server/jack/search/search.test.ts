import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"

// Stand-ins for the Prisma calls the sources make: raw full-text queries and a few reads
const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  connectorState: { findUnique: vi.fn() },
  knowledgeEntry: { findUnique: vi.fn() },
  externalDocument: { findUnique: vi.fn() },
  jackMessage: { findUnique: vi.fn(), findMany: vi.fn() },
  teamsMessage: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  teamsChannel: { findUnique: vi.fn() },
  post: { findUnique: vi.fn() },
  page: { findUnique: vi.fn() },
  event: { findUnique: vi.fn() },
  galleryAlbum: { findUnique: vi.fn() },
  instagramPost: { findUnique: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { search, sourcesFor } from "./search"
import { SEARCH_READERS, SEARCH_SOURCES } from "./registry"
import { DOCUMENTS_OFF, documentsSource } from "./sources/documents"
import { knowledgeAgeDays, knowledgeSource } from "./sources/knowledge"
import { JACK_ANSWER_LABEL, roomsSource } from "./sources/rooms"
import { siteSource } from "./sources/site"
import { TEAMS_OFF, THREAD_MESSAGES, teamsSource, threadWindow } from "./sources/teams"
import type { SearchHit, SearchSource } from "./types"

/** The parameters of the raw query a source ran */
const sqlValues = (call = 0) => (db.$queryRaw.mock.calls[call][0] as Prisma.Sql).values
const sqlText = (call = 0) => (db.$queryRaw.mock.calls[call][0] as Prisma.Sql).sql

const hit = (source: string, rank: number, date: string | null = null): SearchHit => ({ source, type: source, id: `${source}-${rank}`, title: source, url: `/${source}`, snippet: "", date, meta: {}, rank })
const fakeSource = (key: string, hits: SearchHit[], extra: Partial<SearchSource> = {}): SearchSource => ({ key, description: key, byDefault: true, search: vi.fn(async () => hits), readers: [], ...extra })

beforeEach(() => {
  db.$queryRaw.mockResolvedValue([])
})

describe("the source registry", () => {
  it("has the club-data sources in order, and a reader for every type a hit can have", () => {
    expect(SEARCH_SOURCES.map((s) => s.key)).toEqual(["knowledge", "documents", "rooms", "site", "teams"])
    expect(SEARCH_READERS.map((r) => r.type)).toEqual(["knowledge", "document", "room_message", "post", "page", "event", "album", "instagram", "site_page", "teams"])
  })
})

describe("search", () => {
  it("merges every source's hits by rank, newest first on a tie, and keeps the limit", async () => {
    const registry = [
      fakeSource("a", [hit("a", 0.9), hit("a", 0.2)]),
      fakeSource("b", [hit("b", 0.5, "2026-10-01T00:00:00.000Z"), hit("b", 0.5, "2026-10-20T00:00:00.000Z")]),
    ]
    const { hits, outcomes } = await search({ query: "budget", limit: 3, registry })
    expect(hits.map((h) => [h.source, h.rank, h.date])).toEqual([
      ["a", 0.9, null],
      ["b", 0.5, "2026-10-20T00:00:00.000Z"],
      ["b", 0.5, "2026-10-01T00:00:00.000Z"],
    ])
    expect(outcomes).toEqual([
      { source: "a", status: "searched", hits: 2 },
      { source: "b", status: "searched", hits: 2 },
    ])
    expect(registry[0].search).toHaveBeenCalledWith({ query: "budget", limit: 3, includeJackReplies: false, signal: undefined })
  })

  it("searches only the sources asked for, else the default ones", async () => {
    const registry = [fakeSource("a", []), fakeSource("b", []), fakeSource("c", [], { byDefault: false })]
    expect(sourcesFor(undefined, registry).map((s) => s.key)).toEqual(["a", "b"])
    expect(sourcesFor([], registry).map((s) => s.key)).toEqual(["a", "b"])
    expect(sourcesFor(["c", "a"], registry).map((s) => s.key)).toEqual(["a", "c"])
  })

  it("skips a source that's switched off and reports one that fails, without failing the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const off = fakeSource("off", [hit("off", 1)], { unavailable: async () => "It isn't connected." })
    const broken = fakeSource("broken", [], { search: vi.fn(async () => Promise.reject(new Error("relation does not exist"))) })
    const { hits, outcomes } = await search({ query: "x", limit: 5, registry: [off, broken, fakeSource("ok", [hit("ok", 0.3)])] })
    expect(hits.map((h) => h.source)).toEqual(["ok"])
    expect(off.search).not.toHaveBeenCalled()
    expect(outcomes).toEqual([
      { source: "off", status: "unavailable", reason: "It isn't connected." },
      // The database's message stays in the log, not in what the model reads
      { source: "broken", status: "failed", reason: "It couldn't be searched just now." },
      { source: "ok", status: "searched", hits: 1 },
    ])
  })
})

describe("the rooms source", () => {
  const row = (kind: string, persona: string | null = null) => ({ id: "m1", roomId: "r1", kind, persona, createdAt: new Date("2026-10-19T23:00:00Z"), roomTitle: null, author: kind === "user" ? "Dylan" : null, rank: 0.4, snippet: "  the  GM 2\n plan " })

  it("searches officers' messages and room notes by default, never Jack's answers", async () => {
    db.$queryRaw.mockResolvedValue([row("user")])
    const hits = await roomsSource.search({ query: "plan", limit: 5, includeJackReplies: false })
    expect(sqlValues()).toEqual(expect.arrayContaining(["user", "system"]))
    expect(sqlValues()).not.toContain("assistant")
    expect(hits).toEqual([
      {
        source: "rooms",
        type: "room_message",
        id: "m1",
        title: "Dylan in “Untitled room”",
        url: "/admin/jack/r1?m=m1",
        snippet: "the GM 2 plan",
        date: "2026-10-19T23:00:00.000Z",
        meta: { room: "Untitled room", by: "Dylan" },
        rank: 0.4,
      },
    ])
  })

  it("leaves out the question the searching reply is answering", async () => {
    await roomsSource.search({ query: "plan", limit: 5, includeJackReplies: false, replyId: "reply-9" })
    expect(sqlText()).toContain(`m."answeredById" IS DISTINCT FROM`)
    expect(sqlValues()).toContain("reply-9")
    await roomsSource.search({ query: "plan", limit: 5, includeJackReplies: false })
    expect(sqlText(1)).not.toContain("answeredById")
  })

  it("adds Jack's answers only when asked, labelled as not a source", async () => {
    db.$queryRaw.mockResolvedValue([row("assistant", "lift")])
    const [found] = await roomsSource.search({ query: "plan", limit: 5, includeJackReplies: true })
    expect(sqlValues()).toEqual(expect.arrayContaining(["user", "system", "assistant"]))
    expect(found.title).toBe(`${JACK_ANSWER_LABEL}, in “Untitled room”`)
    expect(found.meta.by).toBe(JACK_ANSWER_LABEL)
  })

  it("reads a message with the messages around it, Jack's labelled", async () => {
    const at = (min: number) => new Date(Date.UTC(2026, 9, 19, 23, min))
    db.jackMessage.findUnique.mockResolvedValue({ id: "m2", roomId: "r1", kind: "user", persona: null, content: "What did we decide?", status: "done", createdAt: at(5), author: { displayName: "Gray" }, room: { title: "GM 2" } })
    db.jackMessage.findMany
      .mockResolvedValueOnce([{ id: "m1", kind: "system", persona: null, content: "Alex renamed this room “GM 2”", status: "done", createdAt: at(1), author: { displayName: "Alex" } }])
      .mockResolvedValueOnce([{ id: "m3", kind: "assistant", persona: "jack", content: "x".repeat(2_500), status: "done", createdAt: at(6), author: null }])
    const [reader] = roomsSource.readers
    const result = await reader.read("m2", {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const lines = result.doc.text.split("\n\n")
    expect(lines[0]).toBe("# Room “GM 2”")
    expect(lines[1]).toBe("Mon 2026-10-19 18:01 CT · Room note: Alex renamed this room “GM 2”")
    expect(lines[2]).toBe("→ (the message you opened) Mon 2026-10-19 18:05 CT · Gray: What did we decide?")
    expect(lines[3].startsWith(`Mon 2026-10-19 18:06 CT · Jack [${JACK_ANSWER_LABEL}]: xxx`)).toBe(true)
    expect(lines[3]).toMatch(/x… \(500 more characters: read this message for all of it\)$/)
    expect(result.doc.url).toBe("/admin/jack/r1?m=m2")
  })
})

describe("the knowledge source", () => {
  it("dates an entry by when it was reviewed, else its source date, else its last edit", () => {
    const now = new Date("2026-10-22T12:00:00Z")
    const updatedAt = new Date("2026-10-01T12:00:00Z")
    expect(knowledgeAgeDays({ reviewedAt: null, sourceDate: null, updatedAt }, now)).toBe(21)
    expect(knowledgeAgeDays({ reviewedAt: null, sourceDate: new Date("2026-04-25T12:00:00Z"), updatedAt }, now)).toBe(180)
    expect(knowledgeAgeDays({ reviewedAt: new Date("2026-10-21T12:00:00Z"), sourceDate: new Date("2020-01-01"), updatedAt }, now)).toBe(1)
  })

  it("leaves out archived entries and marks Jack's unreviewed ones", async () => {
    db.$queryRaw.mockResolvedValue([
      { id: "k1", title: "Sponsor tiers", tags: ["sponsors"], sourceType: "JACK", sourceNote: "GM 2 room", sourceDate: null, reviewedAt: null, updatedAt: new Date(), rank: 0.7, snippet: "Gold tier" },
    ])
    const [found] = await knowledgeSource.search({ query: "tiers", limit: 5, includeJackReplies: false })
    expect(sqlText()).toContain(`k."archivedAt" IS NULL`)
    // Linked to the entry's own page (the Knowledge list has no ?entry=)
    expect(found).toMatchObject({ type: "knowledge", url: "/admin/knowledge/k1", meta: { notReviewed: true, tags: "sponsors", from: "GM 2 room", ageDays: 0 } })
  })

  it("reads an entry with its current version id, for updates", async () => {
    db.knowledgeEntry.findUnique.mockResolvedValue({
      id: "k1",
      title: "Sponsor tiers",
      body: "# Tiers\nGold, Silver",
      tags: [],
      sourceType: "MANUAL",
      sourceUrl: null,
      sourceNote: null,
      sourceDate: null,
      reviewedAt: null,
      archivedAt: null,
      updatedAt: new Date(),
      owner: { displayName: "Gray", handle: "gray" },
      versions: [{ id: "v3" }],
    })
    const result = await knowledgeSource.readers[0].read("k1", {})
    expect(result).toMatchObject({ ok: true, doc: { url: "/admin/knowledge/k1", text: "# Tiers\nGold, Silver", meta: { versionId: "v3", owner: "Gray (@gray)" } } })
    // The newest version the way the knowledge service picks it (time, then id), so an update based on it isn't refused
    const query = db.knowledgeEntry.findUnique.mock.calls[0][0] as { select: { versions: unknown } }
    expect(query.select.versions).toEqual({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true } })
    db.knowledgeEntry.findUnique.mockResolvedValue(null)
    expect(await knowledgeSource.readers[0].read("gone", {})).toEqual({ ok: false, error: expect.stringContaining("No knowledge entry gone") })
  })
})

describe("the documents source", () => {
  it("searches documents that weren't deleted, linking to Drive or SharePoint", async () => {
    db.$queryRaw.mockResolvedValue([{ id: "d1", name: "Budget.xlsx", path: "/Finance", source: "drive", webUrl: "https://docs.google.com/x", mimeType: "x", modifiedAt: new Date("2026-10-01"), rank: 0.3, snippet: "budget" }])
    const [found] = await documentsSource.search({ query: "budget", limit: 5, includeJackReplies: false })
    expect(sqlText()).toContain(`e."deletedAt" IS NULL`)
    expect(found).toMatchObject({ type: "document", title: "Budget.xlsx", url: "https://docs.google.com/x", meta: { in: "Google Drive", folder: "/Finance" } })
  })

  it("won't read a deleted document or one with no text", async () => {
    db.connectorState.findUnique.mockResolvedValue({ enabled: true })
    const base = { id: "d1", name: "Budget.xlsx", path: "/", source: "sharepoint", webUrl: "https://x.sharepoint.com/a", mimeType: "x", modifiedAt: new Date() }
    db.externalDocument.findUnique.mockResolvedValueOnce({ ...base, text: null, textStatus: "ok", deletedAt: new Date() })
    expect(await documentsSource.readers[0].read("d1", {})).toEqual({ ok: false, error: "Budget.xlsx was removed from SharePoint, so its text is gone." })
    db.externalDocument.findUnique.mockResolvedValueOnce({ ...base, text: null, textStatus: "too_large", deletedAt: null })
    expect(await documentsSource.readers[0].read("d1", {})).toEqual({ ok: false, error: expect.stringContaining("too large") })
    db.externalDocument.findUnique.mockResolvedValueOnce({ ...base, text: null, textStatus: "restricted", deletedAt: null })
    expect(await documentsSource.readers[0].read("d1", {})).toEqual({ ok: false, error: expect.stringContaining("turned off downloads") })
  })

  it("searches and reads only sources whose connector is switched on (documents track)", async () => {
    // Drive on, SharePoint off
    db.connectorState.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ enabled: where.id === "google-drive" }))
    expect(await documentsSource.unavailable!()).toBeNull()
    await documentsSource.search({ query: "budget", limit: 5, includeJackReplies: false })
    expect(sqlText()).toContain("e.source = ANY(")
    expect(sqlValues()).toContainEqual(["drive"])
    db.externalDocument.findUnique.mockResolvedValueOnce({ id: "d1", name: "Budget.xlsx", path: "/", source: "sharepoint", webUrl: "https://x.sharepoint.com/a", mimeType: "x", modifiedAt: new Date(), text: "secret plans", textStatus: "ok", deletedAt: null })
    expect(await documentsSource.readers[0].read("d1", {})).toEqual({ ok: false, error: "SharePoint isn't connected, so its documents can't be read." })
    // Both off: the source says so, and search skips it
    db.connectorState.findUnique.mockResolvedValue({ enabled: false })
    expect(await documentsSource.unavailable!()).toBe(DOCUMENTS_OFF)
  })
})

describe("the Teams source", () => {
  it("is unavailable unless an admin switched the teams connector on (no row means off)", async () => {
    db.connectorState.findUnique.mockResolvedValueOnce(null)
    expect(await teamsSource.unavailable!()).toBe(TEAMS_OFF)
    db.connectorState.findUnique.mockResolvedValueOnce({ enabled: false })
    expect(await teamsSource.unavailable!()).toBe(TEAMS_OFF)
    db.connectorState.findUnique.mockResolvedValueOnce({ enabled: true })
    expect(await teamsSource.unavailable!()).toBeNull()
    expect(db.connectorState.findUnique).toHaveBeenCalledWith({ where: { id: "teams" }, select: { enabled: true } })
  })

  it("won't read a message while Teams is off", async () => {
    db.connectorState.findUnique.mockResolvedValue({ enabled: false })
    expect(await teamsSource.readers[0].read("t1", {})).toEqual({ ok: false, error: TEAMS_OFF })
    expect(db.teamsMessage.findUnique).not.toHaveBeenCalled()
  })

  describe("reading a thread", () => {
    type TeamsRow = { id: string; channelId: string; replyToId: string | null; authorName: string; content: string; createdAt: Date; editedAt: Date | null; deletedAt: Date | null }
    const at = (min: number) => new Date(Date.UTC(2026, 9, 19, 23, min))
    const teamsRow = (id: string, min: number, replyToId: string | null = "t0"): TeamsRow => ({ id, channelId: "19:abc", replyToId, authorName: "Gray", content: `Message ${id}`, createdAt: at(min), editedAt: null, deletedAt: null })

    /** The rows matching a where like the reader's: equality, OR, and lt / gt / gte on dates and ids */
    function matches(row: TeamsRow, where: Record<string, unknown>): boolean {
      return Object.entries(where).every(([key, condition]) => {
        if (key === "OR") return (condition as Record<string, unknown>[]).some((w) => matches(row, w))
        const value = row[key as keyof TeamsRow]
        if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime()
        if (condition && typeof condition === "object") {
          const { lt, gt, gte } = condition as { lt?: Date | string; gt?: Date | string; gte?: Date | string }
          const v = value as Date | string
          return (lt === undefined || v < lt) && (gt === undefined || v > gt) && (gte === undefined || v >= gte)
        }
        return value === condition
      })
    }

    /** Serves the reader's queries from `rows` */
    function thread(rows: TeamsRow[]) {
      db.connectorState.findUnique.mockResolvedValue({ enabled: true })
      db.teamsChannel.findUnique.mockResolvedValue({ name: "general", teamId: "team-1" })
      db.teamsMessage.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null)
      db.teamsMessage.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null)
      db.teamsMessage.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length)
      db.teamsMessage.findMany.mockImplementation(async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy: { createdAt: "asc" | "desc" }[]; take: number }) => {
        const sign = orderBy[0].createdAt === "asc" ? 1 : -1
        return rows
          .filter((r) => matches(r, where))
          .sort((a, b) => sign * (a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)))
          .slice(0, take)
      })
    }

    it("reads a short thread whole, oldest first, and links into Teams", async () => {
      thread([{ ...teamsRow("t0", 0, null), authorName: "Dylan", content: "Budget?" }, { ...teamsRow("t2", 5), content: "Approved." }])
      const result = await teamsSource.readers[0].read("t2", {})
      expect(result).toMatchObject({
        ok: true,
        doc: { title: "Thread in #general", url: "https://teams.microsoft.com/l/message/19%3Aabc/t2?groupId=team-1&parentMessageId=t0", date: "2026-10-19T23:05:00.000Z", meta: { replies: 1, shown: 2 } },
      })
      if (result.ok) expect(result.doc.text.split("\n\n")).toEqual(["# Thread in #general", "Mon 2026-10-19 18:00 CT · Dylan: Budget?", "→ (the message you opened) Mon 2026-10-19 18:05 CT · Gray: Approved."])
    })

    it("always includes the message opened: a late reply in a long thread comes with the replies before it", async () => {
      thread([teamsRow("t0", 0, null), ...Array.from({ length: 40 }, (_, i) => teamsRow(`r${String(i + 1).padStart(2, "0")}`, i + 1))])
      const result = await teamsSource.readers[0].read("r35", {})
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const lines = result.doc.text.split("\n\n").slice(1)
      expect(lines).toHaveLength(THREAD_MESSAGES + 1)
      expect(lines[0]).toContain("Message t0")
      expect(lines[1]).toBe("(11 earlier replies not shown)")
      expect(lines[2]).toContain("Message r12")
      expect(lines.filter((line) => line.startsWith("→ (the message you opened)"))).toEqual([expect.stringContaining("Message r35")])
      expect(lines.at(-1)).toContain("Message r40")
      expect(result.doc).toMatchObject({ date: at(35).toISOString(), meta: { replies: 40, shown: THREAD_MESSAGES } })
    })

    it("opens a thread's first message with its first replies, saying how many more there are", async () => {
      thread([teamsRow("t0", 0, null), ...Array.from({ length: 40 }, (_, i) => teamsRow(`r${String(i + 1).padStart(2, "0")}`, i + 1))])
      const result = await teamsSource.readers[0].read("t0", {})
      if (!result.ok) throw new Error(result.error)
      const lines = result.doc.text.split("\n\n").slice(1)
      expect(lines[0]).toMatch(/^→ \(the message you opened\) .*Message t0$/)
      expect(lines[1]).toContain("Message r01")
      expect(lines.at(-2)).toContain("Message r29")
      expect(lines.at(-1)).toBe("(11 later replies not shown)")
    })
  })

  it("picks the replies around the one opened: half before it, more when few come after", () => {
    const nums = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i)
    expect(threadWindow(nums(29), nums(29), 29)).toEqual({ before: nums(14), fromOpened: nums(15) })
    expect(threadWindow(nums(29), nums(6), 29)).toEqual({ before: nums(23), fromOpened: nums(6) })
    expect(threadWindow(nums(3), nums(29), 29)).toEqual({ before: nums(3), fromOpened: nums(26) })
    expect(threadWindow([], nums(5), 29)).toEqual({ before: [], fromOpened: nums(5) })
  })
})

describe("the site source: public items only", () => {
  it("searches published posts, shown pages, public events, albums with photos and visible Instagram posts", async () => {
    db.$queryRaw.mockResolvedValue([])
    await siteSource.search({ query: "rules", limit: 5, includeJackReplies: false })
    const text = sqlText()
    expect(text).toContain(`p.visibility = 'public' AND p."publishedAt" <= clock.now`)
    expect(text).toContain(`g.visibility = 'public' AND g.slug IN`)
    expect(text).toContain(`e.status NOT IN ('DRAFT', 'SCHEDULED') OR (e.status = 'SCHEDULED' AND e."publishedAt" <= clock.now)`)
    expect(text).toMatch(/FROM "GalleryAlbum" a\s+WHERE EXISTS \(SELECT 1 FROM "GalleryImage" gi WHERE gi\."albumId" = a\.id\)/)
    expect(text).toContain("i.hidden = false")
    expect(text).not.toMatch(/meetingUrl|streamUrl/)
    expect(sqlValues()).toContain("lone-star-cup-rules")
  })

  it("links each kind to its public page, and drops one with no public link", async () => {
    db.$queryRaw.mockResolvedValue([
      { type: "post", id: "p1", title: "Season 3", key: "season-3", date: new Date("2026-10-01"), rank: 0.5, snippet: "" },
      { type: "page", id: "g1", title: "Rules", key: "lone-star-cup-rules", date: null, rank: 0.4, snippet: "" },
      { type: "page", id: "g2", title: "Hidden", key: "not-shown-anywhere", date: null, rank: 0.4, snippet: "" },
      { type: "event", id: "e1", title: "GM 2", key: "gm-2", date: null, rank: 0.3, snippet: "" },
      { type: "album", id: "a1", title: "Fall social", key: "fall social", date: null, rank: 0.2, snippet: "" },
      { type: "instagram", id: "i1", title: "Race\nday!", key: "https://www.instagram.com/p/abc/", date: null, rank: 0.1, snippet: "" },
      { type: "instagram", id: "i2", title: "Fake", key: "https://evil.example/p/abc/", date: null, rank: 0.1, snippet: "" },
    ])
    const hits = await siteSource.search({ query: "x", limit: 10, includeJackReplies: false })
    expect(hits.map((h) => [h.type, h.url, h.title])).toEqual([
      ["post", "/news/season-3", "Season 3"],
      ["page", "/lone-star-cup/rules", "Rules"],
      ["event", "/events/gm-2", "GM 2"],
      ["album", "/gallery?album=fall%20social", "Fall social"],
      ["instagram", "https://www.instagram.com/p/abc/", "Instagram: Race day!"],
    ])
  })

  const reader = (type: string) => SEARCH_READERS.find((r) => r.type === type)!

  it("reads an album only once it has photos, as the gallery lists it", async () => {
    const album = { id: "a1", title: "Fall social", slug: "fall-social", description: "Draft caption", date: null, event: null }
    db.galleryAlbum.findUnique.mockResolvedValue({ ...album, _count: { images: 0 } })
    expect(await reader("album").read("a1", {})).toEqual({ ok: false, error: expect.stringContaining("No public gallery album a1") })
    db.galleryAlbum.findUnique.mockResolvedValue({ ...album, _count: { images: 12 } })
    expect(await reader("album").read("a1", {})).toMatchObject({ ok: true, doc: { url: "/gallery?album=fall-social", meta: { photos: 12 } } })
  })

  it("won't read a draft or scheduled post, a draft event, a hidden Instagram post or a page the site doesn't show", async () => {
    db.post.findUnique.mockResolvedValue({ id: "p1", title: "Draft", slug: "draft", excerpt: null, bodyMd: "x", publishedAt: null, visibility: "public", author: null })
    expect((await reader("post").read("p1", {})).ok).toBe(false)
    db.post.findUnique.mockResolvedValue({ id: "p1", title: "Soon", slug: "soon", excerpt: null, bodyMd: "x", publishedAt: new Date(Date.now() + 86_400_000), visibility: "public", author: null })
    expect((await reader("post").read("p1", {})).ok).toBe(false)
    db.event.findUnique.mockResolvedValue({ id: "e1", status: "DRAFT", visibility: "public", publishedAt: null })
    expect((await reader("event").read("e1", {})).ok).toBe(false)
    db.instagramPost.findUnique.mockResolvedValue({ id: "i1", caption: "x", permalink: "https://www.instagram.com/p/x/", mediaType: "IMAGE", postedAt: new Date(), hidden: true })
    expect((await reader("instagram").read("i1", {})).ok).toBe(false)
    db.page.findUnique.mockResolvedValue({ id: "g2", title: "Hidden", slug: "not-shown-anywhere", bodyMd: "x", visibility: "public", updatedAt: new Date() })
    expect((await reader("page").read("g2", {})).ok).toBe(false)
  })

  it("reads a public event without its meeting or stream links", async () => {
    db.event.findUnique.mockResolvedValue({
      id: "e1",
      title: "GM 2",
      slug: "gm-2",
      summary: "Second general meeting",
      description: "Plans for the season.",
      status: "PUBLISHED",
      visibility: "public",
      publishedAt: new Date("2026-10-01"),
      startsAtUtc: new Date("2026-10-19T23:00:00Z"),
      endsAtUtc: new Date("2026-10-20T01:00:00Z"),
      registrationEnabled: true,
      registrationOpensAt: null,
      registrationClosesAt: null,
      registrationMax: 40,
      registrationFeeCents: null,
      series: null,
      venue: { name: "GDC", room: "2.216", addressLine1: null, city: "Austin", state: "TX" },
    })
    const result = await reader("event").read("e1", {})
    const select = db.event.findUnique.mock.calls[0][0].select
    expect(select.meetingUrl).toBeUndefined()
    expect(select.streamUrl).toBeUndefined()
    expect(result).toMatchObject({ ok: true, doc: { url: "/events/gm-2" } })
    if (result.ok) expect(result.doc.text).toContain("Where: GDC · 2.216 · Austin, TX")
  })
})
