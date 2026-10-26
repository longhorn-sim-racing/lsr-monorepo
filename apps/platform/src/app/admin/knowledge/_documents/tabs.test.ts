import { createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The tabs render on the server; their filter is a client component that needs the router
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => "/admin/knowledge", useSearchParams: () => new URLSearchParams("tab=documents") }))
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: unknown }) => createElement("a", { href, ...props }, children as never) }))

const sources = vi.hoisted(() => ({ enabled: [] as string[] }))
const queries = vi.hoisted(() => ({ listDocuments: vi.fn(), listTeamsMessages: vi.fn() }))
const teams = vi.hoisted(() => ({ enabled: vi.fn() }))

vi.mock("@/server/connectors/documents/sources", () => ({
  DOCUMENT_SOURCES: [
    { source: "drive", label: "Google Drive" },
    { source: "sharepoint", label: "SharePoint" },
  ],
  DOCUMENT_SOURCE_LABEL: { drive: "Google Drive", sharepoint: "SharePoint" },
  enabledDocumentSources: async () => sources.enabled,
}))
vi.mock("@/server/queries/documents", async (importOriginal) => ({ ...(await importOriginal<object>()), ...queries }))
vi.mock("@/server/connectors/teams/connector", () => ({ teamsConnector: teams }))

import { DocumentsTab } from "./documents-tab"
import { TeamsTab } from "./teams-tab"

const render = async (tab: Promise<ReactElement>) => renderToStaticMarkup(await tab)

beforeEach(() => {
  sources.enabled = []
  teams.enabled.mockResolvedValue(false)
})

describe("the Documents tab", () => {
  it("says documents aren't connected, with a link to Connections, when neither source is on", async () => {
    const html = await render(DocumentsTab({ searchParams: { tab: "documents" } }))
    expect(html).toContain("Documents aren&#x27;t connected")
    expect(html).toContain('href="/admin/connections"')
    expect(queries.listDocuments).not.toHaveBeenCalled()
  })

  it("lists the switched-on source's documents: link with its host, folder, a badge when the text wasn't read, and names the source that's off", async () => {
    sources.enabled = ["drive"]
    queries.listDocuments.mockResolvedValue({
      rows: [
        { id: "1", name: "Storage Closet Inventory", path: "/Operations", source: "drive", webUrl: "https://docs.google.com/document/d/x/edit", mimeType: "x", modifiedAt: new Date("2026-10-12T15:00:00Z"), textStatus: "ok" },
        { id: "2", name: "Signed Agreement.pdf", path: "/Sponsors", source: "drive", webUrl: "https://drive.google.com/file/d/y/view", mimeType: "application/pdf", modifiedAt: new Date("2026-10-10T15:00:00Z"), textStatus: "restricted" },
      ],
      total: 2,
      page: 1,
      pageCount: 1,
      counts: { drive: 2 },
    })
    const html = await render(DocumentsTab({ searchParams: { tab: "documents", q: "closet" } }))
    expect(queries.listDocuments).toHaveBeenCalledWith({ q: "closet", source: undefined, sources: ["drive"], page: 1 })
    expect(html).toContain("SharePoint isn&#x27;t connected")
    expect(html).toContain('href="https://docs.google.com/document/d/x/edit"')
    expect(html).toContain("docs.google.com")
    expect(html).toContain("/Operations")
    expect(html).toContain("Downloads off")
    expect(html).toContain("1–2 of 2")
  })
})

describe("the Teams messages tab", () => {
  it("says Teams isn't connected while it's off", async () => {
    const html = await render(TeamsTab({ searchParams: { tab: "teams" } }))
    expect(html).toContain("Teams isn&#x27;t connected")
    expect(queries.listTeamsMessages).not.toHaveBeenCalled()
  })

  it("lists messages with their channel, author, time and a Teams link", async () => {
    teams.enabled.mockResolvedValue(true)
    queries.listTeamsMessages.mockResolvedValue({
      rows: [{ id: "m1", channelId: "19:c@thread.tacv2", channelName: "Sponsorship", teamId: "t1", replyToId: "m0", authorName: "Fixture Officer C", excerpt: "Fixture Motors confirmed the call", createdAt: new Date("2026-10-15T15:00:00Z"), editedAt: null }],
      total: 1,
      page: 1,
      pageCount: 1,
      channels: [{ id: "19:c@thread.tacv2", name: "Sponsorship", messages: 1 }],
    })
    const html = await render(TeamsTab({ searchParams: { tab: "teams", channel: "19:c@thread.tacv2" } }))
    expect(queries.listTeamsMessages).toHaveBeenCalledWith({ q: "", channelId: "19:c@thread.tacv2", page: 1 })
    expect(html).toContain("Fixture Motors confirmed the call")
    expect(html).toContain("#Sponsorship")
    expect(html).toContain("Fixture Officer C")
    expect(html).toContain("Reply · ")
    expect(html).toContain("https://teams.microsoft.com/l/message/")
    expect(html).toContain("Oct 15, 10:00 AM")
  })
})
