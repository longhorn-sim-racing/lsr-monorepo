import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MeetingDetail } from "@/server/queries/meetings"

const guards = vi.hoisted(() => ({ requireOfficerPage: vi.fn() }))
const queries = vi.hoisted(() => ({ getMeetingDetail: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/queries/meetings", () => queries)
vi.mock("@/server/services/officers", () => ({ listOfficers: async () => [] }))
vi.mock("@/server/connectors/documents/sources", () => ({ DOCUMENT_SOURCE_LABEL: { drive: "Google Drive", sharepoint: "SharePoint" } }))
// The page's forms and menus are client components with their own tests; only the details matter here
vi.mock("../_components/meeting-form", () => ({ MeetingForm: () => null }))
vi.mock("../_components/meeting-parts", () => ({ AddDecisionForm: () => null, DecisionMenu: () => null, DeleteMeetingButton: () => null }))
vi.mock("../../action-items/_components/action-items", () => ({ ActionItemList: () => null, AddActionItemForm: () => null }))
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND")
  },
}))

import MeetingPage from "./page"

const HELD = new Date("2026-10-19T23:30:00Z")
const detail = (extra: Partial<MeetingDetail> = {}): MeetingDetail => ({
  meeting: { id: "m-1", title: "GM 2", kind: "general", heldAt: HELD, agendaMd: null, summaryMd: null, createdAt: HELD, updatedAt: HELD },
  createdBy: null,
  transcript: null,
  transcriptDocument: null,
  room: { id: "room-1", title: "GM planning" },
  decisions: [],
  actionItems: [],
  ...extra,
})

const render = async () => renderToStaticMarkup(await MeetingPage({ params: Promise.resolve({ id: "m-1" }) }))

beforeEach(() => {
  guards.requireOfficerPage.mockResolvedValue({ id: "officer-1", displayName: "Gray" })
})

describe("a meeting's page", () => {
  it("says a transcript came from a synced Drive document, with its folder and the host it opens on", async () => {
    queries.getMeetingDetail.mockResolvedValue(
      detail({ transcriptDocument: { id: "doc-1", name: "GM 2 transcript.vtt", webUrl: "https://drive.google.com/file/d/fake/view", source: "drive", path: "Club/Meetings/Transcripts", deletedAt: null } }),
    )
    const html = await render()
    expect(html).toContain("GM 2 transcript.vtt")
    expect(html).toContain('href="https://drive.google.com/file/d/fake/view"')
    expect(html).toContain("(drive.google.com)")
    expect(html).toContain("Synced from Google Drive · Club/Meetings/Transcripts")
  })

  it("says when that document was removed from Drive since", async () => {
    queries.getMeetingDetail.mockResolvedValue(
      detail({ transcriptDocument: { id: "doc-1", name: "GM 2 transcript.vtt", webUrl: "https://drive.google.com/file/d/fake/view", source: "drive", path: "Club/Meetings/Transcripts", deletedAt: HELD } }),
    )
    expect(await render()).toContain("Removed from Google Drive since")
  })

  it("says a transcript came from a file attached in a Jack room", async () => {
    queries.getMeetingDetail.mockResolvedValue(detail({ transcript: { id: "f-1", filename: "gm-2.vtt", roomId: "room-1" } }))
    const html = await render()
    expect(html).toContain('href="/api/admin/jack/files/f-1"')
    expect(html).toContain("Attached in a Jack room")
    expect(html).not.toContain("Synced from")
  })
})
