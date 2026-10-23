import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }))
const queries = vi.hoisted(() => ({ listMeetings: vi.fn(), listDecisions: vi.fn(), listActionItems: vi.fn(), getMeetingDetail: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/queries/meetings", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/queries/meetings")>()), ...queries }))

import type { ActionItemRow } from "@/server/queries/meetings"
import { meetingsListTool } from "./meetings-list"
import type { JackToolContext } from "./types"

const NOW = new Date("2026-10-22T17:00:00Z")
const ctx: JackToolContext = { roomId: "room-1", actor: { userId: "u-ana", displayName: "Ana" } }
const DYLAN = { id: "u-dylan", displayName: "Dylan", handle: "dylan" }
const HELD = new Date("2026-10-19T23:30:00Z")

const item = (overrides: Partial<ActionItemRow>): ActionItemRow => ({
  id: "ai-1",
  text: "Send the sponsor packet to Apex",
  status: "open",
  dueAt: new Date("2026-10-19T05:00:00Z"),
  doneAt: null,
  createdAt: HELD,
  owner: DYLAN,
  meeting: { id: "m-1", title: "Board meeting", heldAt: HELD },
  overdue: true,
  ...overrides,
})

async function call(input: unknown) {
  return meetingsListTool.run(meetingsListTool.input.parse(input), ctx)
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  db.user.findUnique.mockResolvedValue({ id: "u-dylan" })
  queries.listMeetings.mockResolvedValue([{ id: "m-1", title: "Board meeting", kind: "board", heldAt: HELD, hasAgenda: true, hasSummary: true, decisions: 2, actionItems: 3, openItems: 1 }])
  queries.listDecisions.mockResolvedValue([])
  queries.listActionItems.mockResolvedValue([item({}), item({ id: "ai-2", text: "Book the lounge", owner: null, dueAt: null, overdue: false })])
})

afterEach(() => {
  vi.useRealTimers()
})

describe("meetings_list", () => {
  it("is deferred", () => {
    expect(meetingsListTool.deferred).toBe(true)
  })

  it("lists meetings with their counts, filtered in the query", async () => {
    const result = await call({ type: "board", from: "2026-10-01", query: "sponsors" })
    expect(queries.listMeetings).toHaveBeenCalledWith({ kind: "board", from: new Date("2026-10-01T05:00:00Z"), to: expect.any(Date), query: "sponsors" }, 500)
    expect(JSON.parse(result.forModel).meetings[0]).toEqual({ id: "m-1", title: "Board meeting", type: "board", when: "Mon, Oct 19, 2026, 6:30 PM", agenda: true, summary: true, decisions: 2, actionItems: 3, openActionItems: 1, link: "/admin/meetings/m-1" })
  })

  it("finds decisions with every word, falling back to any word and saying so", async () => {
    queries.listDecisions.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "d-1", text: "Keep the four sponsor tiers for 2026-27.", decidedAt: HELD, meeting: { id: "m-1", title: "Board meeting", kind: "board" }, knowledge: { id: "k-1", title: "Keep the four sponsor tiers", archived: false } },
    ])
    const result = await call({ show: "decisions", query: "sponsor tier pricing" })
    expect(queries.listDecisions.mock.calls[0][0].AND).toHaveLength(3)
    expect(queries.listDecisions.mock.calls[1][0].OR).toHaveLength(3)
    const data = JSON.parse(result.forModel)
    expect(data.note).toMatch(/some of them/)
    expect(data.decisions).toEqual([{ text: "Keep the four sponsor tiers for 2026-27.", decided: "Mon 2026-10-19", meeting: "Board meeting", meetingLink: "/admin/meetings/m-1", decisionLog: "/admin/knowledge/k-1" }])
    expect(result.displays?.[0]).toMatchObject({ kind: "links" })
  })

  it("lists an officer's overdue items, with the counts per owner", async () => {
    queries.listActionItems.mockResolvedValue([item({})])
    const result = await call({ show: "action_items", owner: "dylan", status: "overdue" })
    expect(queries.listActionItems).toHaveBeenCalledWith({ status: "overdue", ownerId: "u-dylan" }, expect.any(Date))
    const data = JSON.parse(result.forModel)
    expect(data.byOwner).toEqual([{ owner: "Dylan (@dylan)", open: 1, overdue: 1 }])
    expect(data.actionItems[0]).toEqual({ id: "ai-1", text: "Send the sponsor packet to Apex", owner: "Dylan (@dylan)", status: "open", due: "Mon 2026-10-19", overdue: true, daysOverdue: 3, meeting: "Board meeting", meetingLink: "/admin/meetings/m-1" })
    db.user.findUnique.mockResolvedValue(null)
    expect(await call({ show: "action_items", owner: "ghost" })).toMatchObject({ isError: true })
  })

  it("opens one meeting in full, cutting a very long summary", async () => {
    queries.getMeetingDetail.mockResolvedValue({
      meeting: { id: "m-1", title: "Board meeting", kind: "board", heldAt: HELD, agendaMd: "1. Sponsors", summaryMd: "x".repeat(7_000), createdAt: HELD, updatedAt: HELD },
      createdBy: null,
      transcript: { id: "f-1", filename: "board.vtt", roomId: "room-1" },
      transcriptDocument: null,
      room: null,
      decisions: [{ id: "d-1", text: "Keep the tiers.", decidedAt: HELD, meeting: null, knowledge: { id: "k-1", title: "Keep the tiers", archived: false } }],
      actionItems: [item({})],
    })
    const data = JSON.parse((await call({ meetingId: "m-1" })).forModel)
    expect(data.meeting).toMatchObject({ title: "Board meeting", agenda: "1. Sponsors", transcript: "board.vtt", agendaPage: "/admin/meetings/m-1/agenda" })
    expect(data.meeting.summary.note).toMatch(/Cut at 6,000 of 7,000/)
    expect(data.decisions).toEqual([{ text: "Keep the tiers.", decisionLog: "/admin/knowledge/k-1" }])
    expect(data.actionItems).toHaveLength(1)
  })
})
