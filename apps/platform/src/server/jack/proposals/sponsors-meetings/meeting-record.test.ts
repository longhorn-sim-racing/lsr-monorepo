import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  meeting: { findUnique: vi.fn() },
  jackFile: { findUnique: vi.fn() },
  externalDocument: { findUnique: vi.fn() },
  jackProposal: { findUnique: vi.fn() },
  jackMessage: { findUnique: vi.fn(), findMany: vi.fn() },
}))
const sources = vi.hoisted(() => ({ enabledDocumentSources: vi.fn() }))
const officers = vi.hoisted(() => ({ officersByHandle: vi.fn(), userNames: vi.fn() }))
const knowledge = vi.hoisted(() => ({ findKnowledgeDuplicates: vi.fn(), knowledgeSecret: vi.fn(), createKnowledgeEntry: vi.fn() }))
const service = vi.hoisted(() => ({
  createMeetingTx: vi.fn(),
  updateMeetingTx: vi.fn(),
  createDecisionsTx: vi.fn(),
  createActionItemTx: vi.fn(),
  linkDecisionsToLog: vi.fn(),
  meetingsOnDay: vi.fn(),
  lockMeetingDayTx: vi.fn(),
  meetingTextKeysTx: vi.fn(),
}))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/officers", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/officers")>()), ...officers }))
vi.mock("@/server/jack/knowledge/service", () => knowledge)
vi.mock("@/server/services/meeting.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/meeting.service")>()), ...service }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/connectors/documents/sources", () => ({ DOCUMENT_SOURCE_LABEL: { drive: "Google Drive", sharepoint: "SharePoint" }, enabledDocumentSources: sources.enabledDocumentSources }))

import { textKey } from "@/lib/meetings"
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
/** A transcript synced from the club's Drive folder (a Transcripts folder) */
const synced = {
  id: "doc-1",
  name: "GM 2 transcript.vtt",
  path: "Club/Meetings/Transcripts",
  source: "drive",
  webUrl: "https://drive.google.com/file/d/fake-gm-2/view",
  mimeType: "text/vtt",
  modifiedAt: new Date("2026-10-20T15:00:00Z"),
  version: "7",
  textStatus: "ok",
  deletedAt: null as Date | null,
}
const noneYet = () => ({ decisions: new Set<string>(), actionItems: new Set<string>() })

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
  db.jackFile.findUnique.mockResolvedValue(transcript)
  db.externalDocument.findUnique.mockResolvedValue(synced)
  sources.enabledDocumentSources.mockResolvedValue(["drive"])
  db.jackProposal.findUnique.mockResolvedValue({ messageId: "reply-1", proposedForId: "u-ana" })
  db.jackMessage.findUnique.mockResolvedValue({
    toolCalls: [
      { id: "t1", name: "room_files", label: "Read board-10-19.vtt", input: { fileId: "f-1" }, status: "done", at: 0, displays: [] },
      { id: "t2", name: "propose_meeting", label: "Proposed a meeting record", input: { kind: "meeting.record" }, status: "done", at: 0, displays: [] },
    ],
  })
  db.jackMessage.findMany.mockResolvedValue([{ id: "msg-1" }])
  officers.officersByHandle.mockImplementation(async (handles: string[]) => new Map(handles.includes("dylan") ? [["dylan", DYLAN]] : []))
  officers.userNames.mockImplementation(async (ids: (string | null)[]) => new Map(ids.includes("u-ana") ? [["u-ana", { id: "u-ana", displayName: "Ana", handle: "ana" }]] : []))
  knowledge.findKnowledgeDuplicates.mockResolvedValue([])
  knowledge.knowledgeSecret.mockReturnValue(null)
  service.meetingsOnDay.mockResolvedValue([])
  service.lockMeetingDayTx.mockResolvedValue(undefined)
  service.meetingTextKeysTx.mockImplementation(async () => noneYet())
  service.createMeetingTx.mockImplementation(async () => ({ ok: true, meeting: { ...existing, id: "m-new", agendaMd: null }, changed: [] }))
  service.updateMeetingTx.mockImplementation(async (_tx, _id, changes: Record<string, unknown>) => ({ ok: true, meeting: existing, changed: Object.keys(changes) }))
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

  it("describes a new meeting from a transcript: its fields, then a row for the meeting, each decision and each action item", async () => {
    knowledge.findKnowledgeDuplicates.mockImplementation(async ({ title }: { title: string }) => (title === "GM 2 venue" ? [{ id: "k-9", title: "Where GMs happen", score: 0.7, reason: "text", updatedAt: HELD }] : []))
    const prepared = await meetingRecordKind.prepare(record, ctx)
    expect(prepared.view.title).toBe("Record the meeting “Board meeting” (Mon Oct 19)")
    expect(prepared.view.summary).toBe(
      "Applying it records the meeting with 2 decisions and 2 action items. Each decision also goes to the decision log in Knowledge, as Jack's, not reviewed until an officer marks it. Pick what to keep.",
    )
    expect(prepared.view.diff.map((row) => [row.label, row.after])).toEqual([
      ["Title", "Board meeting"],
      ["Type", "Board"],
      ["When", "Mon, Oct 19, 2026, 6:30 PM"],
      ["Summary", "We went over sponsors and GM 2."],
      ["Transcript", "board-10-19.vtt (room file)"],
    ])
    expect(prepared.view.rows).toEqual([
      { id: "m", label: "Meeting: Board meeting (Mon Oct 19)", detail: "Title, type and time, summary, transcript. Keep it picked to apply any decision or action item" },
      { id: "d1", label: "Decision: Keep the four sponsor tiers for 2026-27", detail: "Keep the four sponsor tiers for 2026-27." },
      { id: "d2", label: "Decision: GM 2 venue", detail: "GM 2 moves to the Alienware lounge. · Similar in Knowledge: “Where GMs happen”" },
      { id: "a1", label: "Action item: Send the sponsor packet to Apex", detail: "Dylan · due Fri Oct 30" },
      { id: "a2", label: "Action item: Book the lounge for GM 2", detail: "No owner · no due date" },
    ])
    expect(prepared.view.people).toEqual([{ name: "Dylan", detail: "Action items" }])
    expect(prepared.fileSha256).toBe("abc123")
    // A newer proposal for a new board meeting that day replaces this card (say, with the title fixed)
    expect(prepared.targetId).toBe("new:2026-10-19:board")
  })

  it("shows a decision's whole text on the card, and a meeting of the same type already recorded that day", async () => {
    const long = `${"We keep the four sponsor tiers and their prices for the 2026-27 season, ".repeat(6)}and revisit in spring.`
    service.meetingsOnDay.mockResolvedValueOnce([{ id: "m-9", title: "Board check-in", kind: "board", heldAt: HELD }])
    const prepared = await meetingRecordKind.prepare({ title: "Board meeting", type: "board", date: "2026-10-19", decisions: [{ text: long }] }, ctx)
    expect(long.length).toBeGreaterThan(300)
    expect(prepared.view.rows?.find((row) => row.id === "d1")?.detail).toBe(long)
    expect(prepared.view.summary).toMatch(/Already recorded that day: “Board check-in”; check this isn't the same meeting\.$/)
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

    service.meetingsOnDay.mockResolvedValueOnce([{ id: "m-1", title: "BOARD meeting", kind: "board", heldAt: HELD }])
    await expect(meetingRecordKind.prepare(record, ctx)).rejects.toThrow(/“BOARD meeting” on Mon Oct 19 is already recorded \(id m-1\)/)
  })

  it("adds to a meeting already recorded: its changed fields as a diff and a row, targeted so a newer one supersedes it", async () => {
    const prepared = await meetingRecordKind.prepare({ meetingId: "m-1", summary: "We went over sponsors.", agenda: "1. Sponsors", decisions: [{ text: "Keep the four tiers." }] }, ctx)
    expect(prepared.view.title).toBe("Add to the meeting “Board meeting”")
    expect(prepared.view.diff).toEqual([{ field: "summaryMd", label: "Summary", before: null, after: "We went over sponsors.", format: "markdown" }])
    expect(prepared.view.rows?.[0]).toEqual({ id: "m", label: "Changes to “Board meeting”", detail: "Summary" })
    expect(prepared.before).toEqual({ meetingId: "m-1", fields: { summaryMd: null } })
    expect(prepared.targetId).toBe("m-1")
    // Only adding decisions or items: no target, so two such proposals for one meeting both stand (repeats are left out at apply)
    const adding = await meetingRecordKind.prepare({ meetingId: "m-1", decisions: [{ text: "Keep the four tiers." }] }, ctx)
    expect(adding.targetId).toBeUndefined()
    expect(adding.view.rows?.map((row) => row.id)).toEqual(["d1"])
    await expect(meetingRecordKind.prepare({ meetingId: "m-1", agenda: "1. Sponsors" }, ctx)).rejects.toBeInstanceOf(ProposalInputError)
    db.meeting.findUnique.mockResolvedValueOnce(null)
    await expect(meetingRecordKind.prepare({ meetingId: "m-gone", summary: "x" }, ctx)).rejects.toThrow(/no meeting with id m-gone/)
  })

  it("keeps a recorded meeting's time when the date is given without one", async () => {
    // The same date restated: nothing about when changes
    const same = await meetingRecordKind.prepare({ meetingId: "m-1", date: "2026-10-19", summary: "We went over sponsors." }, ctx)
    expect(same.view.diff.map((row) => row.field)).toEqual(["summaryMd"])

    const moved: MeetingRecord = { meetingId: "m-1", date: "2026-10-20" }
    const prepared = await meetingRecordKind.prepare(moved, ctx)
    expect(prepared.view.diff).toEqual([{ field: "heldAt", label: "When", before: "Mon, Oct 19, 2026, 6:30 PM", after: "Tue, Oct 20, 2026, 6:30 PM", format: "text" }])
    await meetingRecordKind.apply(moved, applyCtx(prepared.before))
    expect(service.updateMeetingTx.mock.calls[0][2]).toEqual({ heldAt: new Date("2026-10-20T23:30:00Z") })
  })

  it("applies the meeting and the picked rows in one transaction, then writes the decision log as Jack's with where it came from", async () => {
    const { before } = await meetingRecordKind.prepare(record, ctx)
    const result = await meetingRecordKind.apply(record, applyCtx(before, ["m", "d2", "a1"]))

    expect(service.lockMeetingDayTx).toHaveBeenCalledWith(db, "Board meeting", HELD)
    expect(service.createMeetingTx.mock.calls[0].slice(1)).toEqual([
      { title: "Board meeting", type: "board", heldAt: HELD, summaryMd: "We went over sponsors and GM 2." },
      { userId: "u-gray", auditMetadata: audit },
      { transcriptFileId: "f-1", transcriptDocumentId: null, roomId: "room-1" },
    ])
    expect(service.createDecisionsTx.mock.calls[0][2]).toEqual([{ text: "GM 2 moves to the Alienware lounge.", title: "GM 2 venue" }])
    expect(service.createActionItemTx).toHaveBeenCalledTimes(1)
    expect(service.createActionItemTx.mock.calls[0][1]).toEqual({ text: "Send the sponsor packet to Apex", ownerId: "u-dylan", dueAt: new Date("2026-10-30T05:00:00Z") })
    expect(service.createActionItemTx.mock.calls[0][3]).toEqual({ meetingId: "m-new", roomId: "room-1" })
    expect(service.linkDecisionsToLog.mock.calls[0][1]).toEqual([{ decision: expect.objectContaining({ id: "d-1" }), title: "GM 2 venue" }])
    expect(service.linkDecisionsToLog.mock.calls[0][3]).toEqual({
      roomId: "room-1",
      provenance: {
        roomId: "room-1",
        replyId: "reply-1",
        messageIds: ["msg-1"],
        askedBy: { userId: "u-ana", name: "Ana" },
        tools: [
          { name: "room_files", input: '{"fileId":"f-1"}', label: "Read board-10-19.vtt" },
          { name: "propose_meeting", input: '{"proposalId":"prop-1","fileId":"f-1"}', label: "Meeting record applied by Gray, from board-10-19.vtt" },
        ],
        at: expect.any(String),
      },
    })
    expect(result).toMatchObject({
      summary: "Recorded “Board meeting” (Mon Oct 19) with 1 decision and 1 action item.",
      appliedRows: ["m", "d2", "a1"],
      created: [
        { type: "MEETING", id: "m-new" },
        { type: "ACTION_ITEM", id: "ai-31" },
        { type: "KNOWLEDGE_ENTRY", id: "k-d-1" },
      ],
    })
    expect(result.links?.[0]).toEqual({ title: "Board meeting", url: "/admin/meetings/m-new" })
  })

  it("records a new meeting alone when only its row is picked, and refuses its decisions or items without it", async () => {
    const { before } = await meetingRecordKind.prepare(record, ctx)
    const alone = await meetingRecordKind.apply(record, applyCtx(before, ["m"]))
    expect(service.createMeetingTx).toHaveBeenCalledTimes(1)
    expect(service.createDecisionsTx.mock.calls[0][2]).toEqual([])
    expect(service.createActionItemTx).not.toHaveBeenCalled()
    expect(alone).toMatchObject({ summary: "Recorded “Board meeting” (Mon Oct 19).", appliedRows: ["m"] })

    service.createMeetingTx.mockClear()
    await expect(meetingRecordKind.apply(record, applyCtx(before, ["d1", "a1"]))).rejects.toThrow(/Keep “Meeting: Board meeting” picked/)
    expect(service.createMeetingTx).not.toHaveBeenCalled()
  })

  it("goes stale when the same meeting was recorded meanwhile (checked again under the lock)", async () => {
    const { before } = await meetingRecordKind.prepare(record, ctx)
    service.meetingsOnDay.mockResolvedValueOnce([{ id: "m-2", title: "Board Meeting", kind: "board", heldAt: HELD }])
    await expect(meetingRecordKind.apply(record, applyCtx(before))).rejects.toThrow(new StaleProposalError("“Board Meeting” on Mon Oct 19 is already recorded. Ask Jack to add to it instead."))
    expect(service.lockMeetingDayTx).toHaveBeenCalled()
    expect(service.createMeetingTx).not.toHaveBeenCalled()
  })

  it("leaves out decisions and action items the meeting already has, and goes stale when that's all of them", async () => {
    const p: MeetingRecord = { meetingId: "m-1", decisions: [{ text: "Keep the four tiers." }, { text: "Move GM 2 to the lounge." }], actionItems: [{ text: "Book the lounge" }] }
    const { before } = await meetingRecordKind.prepare(p, ctx)
    service.meetingTextKeysTx.mockResolvedValue({ decisions: new Set([textKey("keep the four  tiers")]), actionItems: new Set<string>() })
    const result = await meetingRecordKind.apply(p, applyCtx(before, ["d1", "d2", "a1"]))
    expect(service.createDecisionsTx.mock.calls[0][2]).toEqual([{ text: "Move GM 2 to the lounge.", title: null }])
    expect(result).toMatchObject({ summary: "Updated “Board meeting” (Mon Oct 19) with 1 decision and 1 action item. Left out 1 decision the meeting already had.", appliedRows: ["d2", "a1"], counts: { alreadyThere: 1 } })

    service.meetingTextKeysTx.mockResolvedValue({ decisions: new Set([textKey("Keep the four tiers")]), actionItems: new Set<string>() })
    service.createDecisionsTx.mockClear()
    await expect(meetingRecordKind.apply(p, applyCtx(before, ["d1"]))).rejects.toThrow(new StaleProposalError("“Board meeting” already has this decision."))
    expect(service.createDecisionsTx).not.toHaveBeenCalled()
  })

  it("leaves a recorded meeting's own fields alone when its row isn't picked", async () => {
    const p: MeetingRecord = { meetingId: "m-1", summary: "We went over sponsors.", actionItems: [{ text: "Book the lounge" }] }
    const { before } = await meetingRecordKind.prepare(p, ctx)
    const result = await meetingRecordKind.apply(p, applyCtx(before, ["a1"]))
    expect(service.updateMeetingTx.mock.calls[0].slice(2)).toEqual([{}, { userId: "u-gray", auditMetadata: audit }, { expected: {} }])
    expect(result.appliedRows).toEqual(["a1"])
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

describe("meeting.record from a synced document", () => {
  const fromDrive: MeetingRecord = { title: "General Meeting 2", type: "general", date: "2026-10-19", documentId: "doc-1", decisions: [{ text: "GM 3 is a karting night." }] }

  it("takes one transcript: a room file or a synced document", () => {
    expect(meetingRecordSchema.safeParse({ ...fromDrive, fileId: "f-1" }).success).toBe(false)
    expect(meetingRecordSchema.safeParse({ meetingId: "m-1", documentId: "doc-1" }).success).toBe(true)
  })

  it("shows where the transcript came from on the card, pins the version it read, and keeps it on the meeting", async () => {
    const prepared = await meetingRecordKind.prepare(fromDrive, ctx)
    expect(prepared.view.diff.find((row) => row.label === "Transcript")).toEqual({ field: "transcript", label: "Transcript", before: null, after: "GM 2 transcript.vtt (Google Drive: Club/Meetings/Transcripts)", format: "text" })
    // An outside link: the card shows its host
    expect(prepared.view.links).toEqual([{ title: "GM 2 transcript.vtt", url: "https://drive.google.com/file/d/fake-gm-2/view" }])
    expect(prepared.before).toEqual({ meetingId: null, fields: {}, document: { id: "doc-1", name: "GM 2 transcript.vtt", modifiedAt: "2026-10-20T15:00:00.000Z", version: "7" } })
    // Only a room file is pinned by sha256 (the framework's check); a document by its version, below
    expect(prepared.fileSha256).toBeUndefined()

    await meetingRecordKind.apply(fromDrive, applyCtx(prepared.before))
    expect(service.createMeetingTx.mock.calls[0][3]).toEqual({ transcriptFileId: null, transcriptDocumentId: "doc-1", roomId: "room-1" })
    // The decision log says where the decision came from
    const provenance = service.linkDecisionsToLog.mock.calls[0][3].provenance
    expect(provenance.tools.at(-1)).toEqual({ name: "propose_meeting", input: '{"proposalId":"prop-1","documentId":"doc-1"}', label: "Meeting record applied by Gray, from GM 2 transcript.vtt" })
  })

  it("refuses a document it can't use: unknown, its source switched off, removed, without text, or not a transcript or notes", async () => {
    db.externalDocument.findUnique.mockResolvedValueOnce(null)
    await expect(meetingRecordKind.prepare(fromDrive, ctx)).rejects.toThrow(/no synced document doc-1\. Find the transcript with search/)
    sources.enabledDocumentSources.mockResolvedValueOnce([])
    await expect(meetingRecordKind.prepare(fromDrive, ctx)).rejects.toThrow("Google Drive isn't connected, so its documents can't be used.")
    db.externalDocument.findUnique.mockResolvedValueOnce({ ...synced, deletedAt: new Date() })
    await expect(meetingRecordKind.prepare(fromDrive, ctx)).rejects.toThrow("GM 2 transcript.vtt was removed from Google Drive.")
    db.externalDocument.findUnique.mockResolvedValueOnce({ ...synced, textStatus: "too_large" })
    await expect(meetingRecordKind.prepare(fromDrive, ctx)).rejects.toThrow(/has no text/)
    db.externalDocument.findUnique.mockResolvedValueOnce({ ...synced, name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" })
    await expect(meetingRecordKind.prepare(fromDrive, ctx)).rejects.toThrow(/Budget isn't a transcript or notes/)
    // A Google Doc of notes, and a Word file by its name, are fine
    db.externalDocument.findUnique.mockResolvedValueOnce({ ...synced, name: "GM 2 notes", mimeType: "application/vnd.google-apps.document" })
    await expect(meetingRecordKind.prepare(fromDrive, ctx)).resolves.toBeTruthy()
    db.externalDocument.findUnique.mockResolvedValueOnce({ ...synced, name: "GM 2 minutes.docx", mimeType: "application/octet-stream" })
    await expect(meetingRecordKind.prepare(fromDrive, ctx)).resolves.toBeTruthy()
  })

  it("goes stale when the document changed or went since it was read", async () => {
    const { before } = await meetingRecordKind.prepare(fromDrive, ctx)
    expect(await meetingRecordKind.checkStale(fromDrive, before)).toBeNull()
    db.externalDocument.findUnique.mockResolvedValueOnce({ ...synced, version: "8", modifiedAt: new Date("2026-10-21T10:00:00Z") })
    expect(await meetingRecordKind.checkStale(fromDrive, before)).toBe("The transcript “GM 2 transcript.vtt” changed in Google Drive since this was proposed.")
    db.externalDocument.findUnique.mockResolvedValueOnce({ ...synced, deletedAt: new Date() })
    expect(await meetingRecordKind.checkStale(fromDrive, before)).toBe("The transcript “GM 2 transcript.vtt” was removed from Google Drive since this was proposed.")
    db.externalDocument.findUnique.mockResolvedValueOnce(null)
    expect(await meetingRecordKind.checkStale(fromDrive, before)).toBe("The transcript “GM 2 transcript.vtt” is no longer synced.")
    // A record built from a room file doesn't look at documents
    db.externalDocument.findUnique.mockClear()
    expect(await meetingRecordKind.checkStale(record, { meetingId: null, fields: {} })).toBeNull()
    expect(db.externalDocument.findUnique).not.toHaveBeenCalled()
  })

  it("replaces a recorded meeting's room-file transcript with a synced one, checked against what it was", async () => {
    db.meeting.findUnique.mockResolvedValue({ ...existing, transcriptFileId: "f-1" })
    const p: MeetingRecord = { meetingId: "m-1", documentId: "doc-1" }
    const prepared = await meetingRecordKind.prepare(p, ctx)
    expect(prepared.view.diff).toEqual([{ field: "transcript", label: "Transcript", before: "board-10-19.vtt (room file)", after: "GM 2 transcript.vtt (Google Drive: Club/Meetings/Transcripts)", format: "text" }])
    expect(prepared.before).toMatchObject({ meetingId: "m-1", fields: { transcriptFileId: "f-1", transcriptDocumentId: null } })
    expect(prepared.targetId).toBe("m-1")

    service.updateMeetingTx.mockResolvedValueOnce({ ok: true, meeting: existing, changed: ["transcriptFileId", "transcriptDocumentId"] })
    const result = await meetingRecordKind.apply(p, applyCtx(prepared.before))
    expect(service.updateMeetingTx.mock.calls[0].slice(2)).toEqual([{}, { userId: "u-gray", auditMetadata: audit }, { transcriptFileId: null, transcriptDocumentId: "doc-1", expected: { transcriptFileId: "f-1", transcriptDocumentId: null } }])
    expect(result.summary).toBe("Updated “Board meeting” (Mon Oct 19).")

    // The same transcript again changes nothing
    db.meeting.findUnique.mockResolvedValue({ ...existing, transcriptDocumentId: "doc-1" })
    await expect(meetingRecordKind.prepare(p, ctx)).rejects.toThrow(/Nothing would change/)
  })
})
