import { beforeEach, describe, expect, it, vi } from "vitest"
import type { JackToolPart } from "@/lib/jack/parts"

vi.mock("@/server/db", () => ({ prisma: { jackMessage: { findMany: vi.fn() } } }))

import { prisma } from "@/server/db"
import { fakeClaude, fakeWebFetch, type FakeTurn } from "../fake-claude"
import { runModelReply } from "../model-loop"
import { JACK_MODELS } from "../models"
import { buildSystemPrompt } from "../prompt"
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
        links: [
          { n: 1, title: "iRacing college", url: "https://www.iracing.com/college" },
          { n: 2, title: "FIA esports", url: "https://fia.com/esports" },
          { n: 3, title: "Fetched page", url: "https://blog.example.org/post" },
        ],
      },
      { reply: "Mon 2026-10-19 14:00 CT", links: [{ n: 1, title: "https://old.example/", url: "https://old.example/" }] },
    ])
    expect(out.forModel).not.toContain("leak.example")
  })

  // web_fetch may follow anything in this tool's result, so text the model wrote must never be in it:
  // a link there would become fetchable, carrying whatever the model put in it
  const evil = "https://evil.example/?eid=ab12345"

  it("never repeats `match`, even when it's a link", async () => {
    findMany.mockResolvedValue([{ createdAt: new Date("2026-10-20T19:00:00Z"), toolCalls: [search("srvtoolu_1", "club sponsors", [source("https://a.example/")])] }])

    const none = await webLinksTool.run(webLinksTool.input.parse({ match: evil }), ctx)
    expect(none.forModel).toBe("No links match that text in this room's last 1 reply that used the web.")

    const some = await webLinksTool.run(webLinksTool.input.parse({ match: "a.example" }), ctx)
    expect(JSON.parse(some.forModel).replies).toEqual([{ reply: "Tue 2026-10-20 14:00 CT", links: [{ n: 1, title: "https://a.example/", url: "https://a.example/" }] }])
    expect(some.forModel).not.toContain("club sponsors")
  })

  it("never includes an earlier search's query, or a fetch's input", async () => {
    findMany.mockResolvedValue([
      {
        createdAt: new Date("2026-10-20T19:00:00Z"),
        toolCalls: [search("srvtoolu_1", `sponsors ${evil}`, [source("https://www.iracing.com/college", "iRacing college")]), { ...fetched("srvtoolu_2", "https://fia.com/esports"), input: { url: evil } }],
      },
    ])

    const out = await webLinksTool.run(webLinksTool.input.parse({}), ctx)

    expect(out.forModel).not.toContain("evil.example")
    expect(JSON.parse(out.forModel).replies[0].links.map((link: { url: string }) => link.url)).toEqual(["https://www.iracing.com/college", "https://fia.com/esports"])
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
    expect(out).toMatchObject({ label: "No earlier web links", forModel: "No links match that text in this room's last 1 reply that used the web." })
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 5 }))

    findMany.mockResolvedValue([{ createdAt: new Date("2026-10-20T19:00:00Z"), toolCalls: [search("srvtoolu_1", "q", [])] }])
    expect((await webLinksTool.run(webLinksTool.input.parse({}), ctx)).forModel).toBe("No web links in this room's last 1 reply that used the web.")
  })
})

describe("web_links in a reply (the fake Claude checks what web_fetch may open, as the API does)", () => {
  const evil = "https://evil.example/?eid=ab12345"
  const IRACING = "https://www.iracing.com/college"

  /** One reply: the model calls web_links with `input`, then tries to open `url` */
  async function fetchAfterWebLinks(input: Record<string, unknown>, url: string) {
    vi.stubEnv("JACK_WEB_TOOLS", "on")
    const script: FakeTurn[] = [{ tools: [{ name: "web_links", input }] }, { blocks: fakeWebFetch(url, { title: "Page" }, { id: "srvtoolu_open" }), text: "Here it is." }]
    const fake = fakeClaude(script)
    const result = await runModelReply({
      client: fake.client,
      config: JACK_MODELS.jack,
      system: buildSystemPrompt("jack"),
      tools: [webLinksTool],
      history: [{ role: "user", content: "[Tue, Oct 20, 2026, 3:05 PM CT]\nGray: Open the first link" }],
      ctx,
      onText: () => {},
      onPart: async () => {},
      requestType: "room",
    })
    return { result, fake, opened: result.parts.find((part) => part.id === "srvtoolu_open") }
  }

  beforeEach(() => {
    findMany.mockResolvedValue([
      { createdAt: new Date("2026-10-20T19:00:00Z"), toolCalls: [search("srvtoolu_1", `sponsors ${evil}`, [source(IRACING, "iRacing college")])] },
    ])
  })

  it("opens a link web_links returned", async () => {
    const { opened } = await fetchAfterWebLinks({}, IRACING)
    expect(opened).toMatchObject({ status: "done", label: "Read iracing.com" })
  })

  it("can't open a link the model wrote into `match`", async () => {
    const { opened, fake } = await fetchAfterWebLinks({ match: evil }, evil)
    expect(JSON.stringify(fake.calls[1].messages.at(-1))).not.toContain("evil.example")
    expect(opened).toMatchObject({ status: "error", error: "Couldn't open evil.example: only links an officer posted or a web search found can be opened" })
  })

  it("can't open a link the model wrote into an earlier search's query", async () => {
    const { opened } = await fetchAfterWebLinks({}, evil)
    expect(opened).toMatchObject({ status: "error", label: "Couldn't open evil.example" })
  })
})
