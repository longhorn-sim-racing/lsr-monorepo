import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ $transaction: vi.fn(), meeting: { findUnique: vi.fn(), findFirst: vi.fn() }, jackFile: { findUnique: vi.fn() } }))
const officers = vi.hoisted(() => ({ officersByHandle: vi.fn() }))
const knowledge = vi.hoisted(() => ({ findKnowledgeDuplicates: vi.fn(), knowledgeSecret: vi.fn(), createKnowledgeEntry: vi.fn() }))
const service = vi.hoisted(() => ({ createMeetingTx: vi.fn(), updateMeetingTx: vi.fn(), createDecisionsTx: vi.fn(), createActionItemTx: vi.fn(), linkDecisionsToLog: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/officers", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/officers")>()), ...officers }))
vi.mock("@/server/jack/knowledge/service", () => knowledge)
vi.mock("@/server/services/meeting.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/meeting.service")>()), ...service }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { meetingRecordKind, meetingRecordSchema, type MeetingRecord } from "./meeting-record"

const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u-ana", displayName: "Ana" } }
const audit = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u-ana" }
const applyCtx = (before: unknown, selectedRows?: string[]): ProposalApplyContext => ({ officer: { userId: "u-gray", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: audit, selectedRows })

const DYLAN = { id: "u-dylan", displayName: "Dylan", handle: "dylan" }
const HELD = new Date("2026-10-19T23:30:00Z") // Mon Oct 19, 6:30 PM Central
const existing = { id: "m-1", title: "Board meeting", kind: "board", heldAt: HELD, agendaMd: "1. Sponsors", summaryMd: null, transcriptFileId: null, transcriptDocumentId: null, roomId: null, createdById: null, createdAt: HELD, updatedAt: HELD }
const transcript = { id: "f-1", roomId: "room-1", filename: "board-10-19.vtt", status: "READY", kind: "TRANSCRIPT", sha256: "abc123" }

const record: MeetingRecord = {
  title: "Board meeting",
  type: "board",
  date: "2026-10-19",
  time: "18:30",
  summary: "We went over sponsors and GM 2.",
  fileId: "f-1",
  decisions: [{ text: "Keep the four sponsor tiers for 2026-27." }, { text: "GM 2 moves to the Alienware lounge.", title: "GM 2 venue" }],
  actionItems: [
    { text: "Send the sponsor packet to Apex", owner: "@dylan", due: "2026-10-30" },
    { text: "Book the lounge for GM 2" },
  ],
}

beforeEach(() => {
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db))
  db.meeting.findUnique.mockResolvedValue(existing)
  db.meeting.findFirst.mockResolvedValue(null)
  db.jackFile.findUnique.mockResolvedValue(transcript)
  officers.officersByHandle.mockImplementation(async (handles: string[]) => new Map(handles.includes("dylan") ? [["dylan", DYLAN]] : []))
  knowledge.findKnowledgeDuplicates.mockResolvedValue([])
  knowledge.knowledgeSecret.mockReturnValue(null)
  service.createMeetingTx.mockImplementation(async () => ({ ok: true, meeting: { ...existing, id: "m-new", agendaMd: null }, changed: [] }))
  service.updateMeetingTx.mockImplementation(async () => ({ ok: true, meeting: existing, changed: [] }))
  service.createDecisionsTx.mockImplementation(async (_tx, _meeting, inputs: { text: string }[]) => inputs.map((d, i) => ({ id: `d-${i + 1}`, text: d.text, meetingId: "m-new", decidedAt: HELD, knowledgeEntryId: null, createdAt: HELD })))
  service.createActionItemTx.mockImplementation(async (_tx, fields: { text: string }) => ({ ok: true, item: { id: `ai-${fields.text.length}`, ...fields }, changed: [] }))
  service.linkDecisionsToLog.mockImplementation(async (_m, decisions: { decision: { id: string } }[]) => decisions.map((d) => ({ decision: d.decision, knowledge: { ok: true, entryId: `k-${d.decision.id}` } })))
})

describe("meeting.record", () => {
  it("is offered by propose_meeting to officers; a new meeting needs its title, type and date", () => {
    expect(meetingRecordKind).toMatchObject({ kind: "meeting.record", tool: "propose_meeting", permission: "officer", targetType: "MEETING" })
    expect(meetingRecordSchema.safeParse({ title: "Board meeting", type: "board" }).success).toBe(false)
    expect(meetingRecordSchema.safeParse({ title: "Board meeting", type: "board", date: "2026-10-19", time: "6:30pm" }).success).toBe(false)
    expect(meetingRecordSchema.safeParse({ meetingId: "m-1", time: "18:30" }).success).toBe(false)
    expect(meetingRecordSchema.safeParse({ meetingId: "m-1" }).success).toBe(false)
    expect(meetingRecordSchema.safeParse({ meetingId: "m-1", summary: "Done" }).success).toBe(true)
  })

  it("describes a new meeting from a transcript: its fields, then a row per decision and action item", async () => {
    knowledge.findKnowledgeDuplicates.mockImplementation(async ({ title }: { title: string }) => (title === "GM 2 venue" ? [{ id: "k-9", title: "Where GMs happen", score: 0.7, reason: "text", updatedAt: HELD }] : []))
    const prepared = await meetingRecordKind.prepare(record, ctx)
    expect(prepared.view.title).toBe("Record the meeting “Board meeting” (Mon Oct 19)")
    expect(prepared.view.summary).toBe("Applying it records the meeting with 2 decisions and 2 action items. Each decision also goes to the decision log in Knowledge. Pick the decisions and action items to keep.")
    expect(prepared.view.diff.map((row) => [row.label, row.after])).toEqual([
      ["Title", "Board meeting"],
      ["Type", "Board"],
      ["When", "Mon, Oct 19, 2026, 6:30 PM"],
      ["Summary", "We went over sponsors and GM 2."],
      ["Transcript", "board-10-19.vtt"],
    ])
    expect(prepared.view.rows).toEqual([
      { id: "d1", label: "Decision: Keep the four sponsor tiers for 2026-27", detail: "Keep the four sponsor tiers for 2026-27." },
      { id: "d2", label: "Decision: GM 2 venue", detail: "GM 2 moves to the Alienware lounge. · Similar in Knowledge: “Where GMs happen”" },
      { id: "a1", label: "Action item: Send the sponsor packet to Apex", detail: "Dylan · due Fri Oct 30" },
      { id: "a2", label: "Action item: Book the lounge for GM 2", detail: "No owner · no due date" },
    ])
    expect(prepared.view.people).toEqual([{ name: "Dylan", detail: "Action items" }])
    expect(prepared.fileSha256).toBe("abc123")
    expect(prepared.targetId).toBeUndefined()
  })

  it("refuses a file from another room or not ready, a secret in a decision, an unknown owner, and a meeting already recorded", async () => {
    db.jackFile.findUnique.mockResolvedValueOnce({ ...transcript, roomId: "room-2" })
    await expect(meetingRecordKind.prepare(record, ctx)).rejects.toThrow(/no file f-1 in this room/)
    db.jackFile.findUnique.mockResolvedValueOnce({ ...transcript, status: "UPLOADING" })
    await expect(meetingRecordKind.prepare(record, ctx)).rejects.toThrow(/isn't ready yet/)
    db.jackFile.findUnique.mockResolvedValueOnce({ ...transcript, kind: "IMAGE" })
    await expect(meetingRecordKind.prepare(record, ctx)).rejects.toThrow(/isn't a transcript or notes/)

    knowledge.knowledgeSecret.mockReturnValueOnce("a Stripe key")
    await expect(meetingRecordKind.prepare(record, ctx)).rejects.toThrow(/^Decision 1: .*a Stripe key/)

    await expect(meetingRecordKind.prepare({ ...record, actionItems: [{ text: "Do it", owner: "ghost" }] }, ctx)).rejects.toThrow(/@ghost isn't an officer's handle/)

    db.meeting.findFirst.mockResolvedValueOnce({ id: "m-1" })
    await expect(meetingRecordKind.prepare(record, ctx)).rejects.toThrow(/already recorded \(id m-1\)/)
  })

  it("adds to a meeting already recorded: its changed fields as a diff, targeted so a newer one supersedes it", async () => {
    const prepared = await meetingRecordKind.prepare({ meetingId: "m-1", summary: "We went over sponsors.", agenda: "1. Sponsors", decisions: [{ text: "Keep the four tiers." }] }, ctx)
    expect(prepared.view.title).toBe("Add to the meeting “Board meeting”")
    expect(prepared.view.diff).toEqual([{ field: "summaryMd", label: "Summary", before: null, after: "We went over sponsors.", format: "markdown" }])
    expect(prepared.before).toEqual({ meetingId: "m-1", fields: { summaryMd: null } })
    expect(prepared.targetId).toBe("m-1")
    await expect(meetingRecordKind.prepare({ meetingId: "m-1", agenda: "1. Sponsors" }, ctx)).rejects.toBeInstanceOf(ProposalInputError)
    db.meeting.findUnique.mockResolvedValueOnce(null)
    await expect(meetingRecordKind.prepare({ meetingId: "m-gone", summary: "x" }, ctx)).rejects.toThrow(/no meeting with id m-gone/)
  })

  it("applies the meeting and the picked rows in one transaction, then writes the decision log", async () => {
    const { before } = await meetingRecordKind.prepare(record, ctx)
    const result = await meetingRecordKind.apply(record, applyCtx(before, ["d2", "a1"]))

    expect(service.createMeetingTx.mock.calls[0].slice(1)).toEqual([
      { title: "Board meeting", type: "board", heldAt: HELD, summaryMd: "We went over sponsors and GM 2." },
      { userId: "u-gray", auditMetadata: audit },
      { transcriptFileId: "f-1", roomId: "room-1" },
    ])
    expect(service.createDecisionsTx.mock.calls[0][2]).toEqual([{ text: "GM 2 moves to the Alienware lounge.", title: "GM 2 venue" }])
    expect(service.createActionItemTx).toHaveBeenCalledTimes(1)
    expect(service.createActionItemTx.mock.calls[0][1]).toEqual({ text: "Send the sponsor packet to Apex", ownerId: "u-dylan", dueAt: new Date("2026-10-30T05:00:00Z") })
    expect(service.createActionItemTx.mock.calls[0][3]).toEqual({ meetingId: "m-new", roomId: "room-1" })
    expect(service.linkDecisionsToLog.mock.calls[0][1]).toEqual([{ decision: expect.objectContaining({ id: "d-1" }), title: "GM 2 venue" }])
    expect(service.linkDecisionsToLog.mock.calls[0][3]).toEqual({ roomId: "room-1" })
    expect(result).toMatchObject({
      summary: "Recorded “Board meeting” (Mon Oct 19) with 1 decision and 1 action item.",
      appliedRows: ["d2", "a1"],
      created: [
        { type: "MEETING", id: "m-new" },
        { type: "ACTION_ITEM", id: "ai-31" },
        { type: "KNOWLEDGE_ENTRY", id: "k-d-1" },
      ],
    })
    expect(result.links?.[0]).toEqual({ title: "Board meeting", url: "/admin/meetings/m-new" })
  })

  it("says when a decision couldn't go to the decision log", async () => {
    service.linkDecisionsToLog.mockImplementation(async (_m, decisions: { decision: { id: string } }[]) => decisions.map((d) => ({ decision: d.decision, knowledge: { ok: false, error: "it looks like it holds a key" } })))
    const { before } = await meetingRecordKind.prepare(record, ctx)
    const result = await meetingRecordKind.apply(record, applyCtx(before))
    expect(result.summary).toMatch(/2 decisions couldn't go to the decision log \(it looks like it holds a key\)/)
    expect(result.counts).toMatchObject({ notInDecisionLog: 2 })
  })

  it("updates only what differed when proposed, and goes stale when the meeting moved on", async () => {
    const p: MeetingRecord = { meetingId: "m-1", title: "Board meeting", summary: "We went over sponsors." }
    const { before } = await meetingRecordKind.prepare(p, ctx)
    await meetingRecordKind.apply(p, applyCtx(before))
    expect(service.updateMeetingTx.mock.calls[0].slice(2)).toEqual([{ summaryMd: "We went over sponsors." }, { userId: "u-gray", auditMetadata: audit }, { expected: { summaryMd: null } }])

    service.updateMeetingTx.mockResolvedValueOnce({ ok: false, reason: "changed", error: "moved" })
    await expect(meetingRecordKind.apply(p, applyCtx(before))).rejects.toThrow(new StaleProposalError("Someone changed the meeting since this was proposed."))
  })

  it("goes stale when an action item's owner stopped being an officer", async () => {
    const { before } = await meetingRecordKind.prepare(record, ctx)
    officers.officersByHandle.mockResolvedValue(new Map())
    await expect(meetingRecordKind.apply(record, applyCtx(before))).rejects.toBeInstanceOf(StaleProposalError)
    expect(service.createMeetingTx).not.toHaveBeenCalled()
  })
})
