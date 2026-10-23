import { beforeEach, describe, expect, it, vi } from "vitest"
import type { JackToolPart } from "@/lib/jack/parts"

vi.mock("@/server/db", () => ({ prisma: { jackMessage: { findMany: vi.fn() } } }))

import { prisma } from "@/server/db"
import { webLinksTool } from "./web-links"

const findMany = prisma.jackMessage.findMany as unknown as ReturnType<typeof vi.fn>
const ctx = { roomId: "room-1", actor: { userId: "officer-gray", displayName: "Gray" } }

const source = (url: string, title = url) => ({ title, url, host: new URL(url).hostname })
const search = (id: string, query: string, sources: ReturnType<typeof source>[]): JackToolPart => ({
  id,
  name: "web_search",
  label: "Searched the web",
  status: "done",
  at: 0,
  input: { query },
  displays: [{ kind: "web_sources", queries: [query], sources }],
})
const fetched = (id: string, url: string): JackToolPart => ({ id, name: "web_fetch", label: "Read", status: "done", at: 0, input: { url }, displays: [{ kind: "web_sources", queries: [], sources: [source(url, "Fetched page")] }] })

beforeEach(() => {
  findMany.mockReset()
})

describe("web_links", () => {
  it("is deferred, offered only with the web tools, and asks only for this room's replies that used the web", async () => {
    expect(webLinksTool).toMatchObject({ name: "web_links", deferred: true, web: true })
    findMany.mockResolvedValue([])

    await webLinksTool.run(webLinksTool.input.parse({}), ctx)

    expect(findMany).toHaveBeenCalledWith({
      where: {
        roomId: "room-1",
        kind: "assistant",
        OR: [{ toolCalls: { array_contains: [{ name: "web_search" }] } }, { toolCalls: { array_contains: [{ name: "web_fetch" }] } }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
      select: { createdAt: true, toolCalls: true },
    })
  })

  it("numbers each reply's links in the order the room shows them, newest reply first, without repeats", async () => {
    findMany.mockResolvedValue([
      {
        createdAt: new Date("2026-10-20T19:00:00Z"),
        toolCalls: [
          search("srvtoolu_1", "sim racing sponsors", [source("https://www.iracing.com/college", "iRacing college"), source("https://fia.com/esports", "FIA esports")]),
          // Not a web part, even with a web_sources display: never read
          { id: "toolu_x", name: "run_sql", label: "Ran a query", status: "done", at: 0, input: {}, displays: [{ kind: "web_sources", queries: [], sources: [source("https://leak.example/?email=a@b.c")] }] },
          fetched("srvtoolu_2", "https://fia.com/esports"),
          fetched("srvtoolu_3", "https://blog.example.org/post"),
        ],
      },
      { createdAt: new Date("2026-10-19T19:00:00Z"), toolCalls: [search("srvtoolu_0", "older", [source("https://old.example/")])] },
    ])

    const out = await webLinksTool.run(webLinksTool.input.parse({}), ctx)

    expect(out.label).toBe("Found 4 earlier web links")
    const body = JSON.parse(out.forModel)
    expect(body.replies).toEqual([
      {
        reply: "Tue 2026-10-20 14:00 CT",
        searched: ["sim racing sponsors"],
        links: [
          { n: 1, title: "iRacing college", url: "https://www.iracing.com/college" },
          { n: 2, title: "FIA esports", url: "https://fia.com/esports" },
          { n: 3, title: "Fetched page", url: "https://blog.example.org/post" },
        ],
      },
      { reply: "Mon 2026-10-19 14:00 CT", searched: ["older"], links: [{ n: 1, title: "https://old.example/", url: "https://old.example/" }] },
    ])
    expect(out.forModel).not.toContain("leak.example")
  })

  it("keeps a link's number when filtering, and skips anything that isn't a web link", async () => {
    findMany.mockResolvedValue([
      {
        createdAt: new Date("2026-10-20T19:00:00Z"),
        toolCalls: [search("srvtoolu_1", "q", [source("https://a.example/one", "One"), { title: "Bad", url: "javascript:alert(1)", host: "" }, source("https://b.example/two", "Two")])],
      },
    ])

    const out = await webLinksTool.run(webLinksTool.input.parse({ match: "two" }), ctx)

    expect(JSON.parse(out.forModel).replies[0].links).toEqual([{ n: 2, title: "Two", url: "https://b.example/two" }])
  })

  it("says when no reply has used the web, or nothing matches", async () => {
    findMany.mockResolvedValue([])
    expect((await webLinksTool.run(webLinksTool.input.parse({}), ctx)).forModel).toBe("No reply in this room has used the web yet.")

    findMany.mockResolvedValue([{ createdAt: new Date("2026-10-20T19:00:00Z"), toolCalls: [search("srvtoolu_1", "q", [source("https://a.example/")])] }])
    const out = await webLinksTool.run(webLinksTool.input.parse({ match: "zzz", replies: 5 }), ctx)
    expect(out).toMatchObject({ label: "No earlier web links", forModel: `No links matching "zzz" in this room's last 1 reply that used the web.` })
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 5 }))
  })
})
