import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  meeting: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
  meetingDecision: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  actionItem: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  user: { findMany: vi.fn() },
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const knowledge = vi.hoisted(() => ({ createKnowledgeEntry: vi.fn(), knowledgeSecret: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/jack/knowledge/service", () => knowledge)

import { addDecision, createMeeting, decisionProblem, deleteMeeting, linkDecisionsToLog, updateActionItem, updateMeeting, createActionItem } from "./meeting.service"

const NOW = new Date("2026-10-22T17:00:00Z")
const HELD = new Date("2026-10-19T23:30:00Z")
const actor = { userId: "officer-1" }

const meeting = (overrides: Record<string, unknown> = {}) => ({
  id: "m-1",
  title: "Board meeting",
  kind: "board",
  heldAt: HELD,
  agendaMd: "1. Sponsors",
  summaryMd: null,
  transcriptFileId: null,
  transcriptDocumentId: null,
  roomId: null,
  createdById: "officer-1",
  createdAt: HELD,
  updatedAt: HELD,
  ...overrides,
})

const item = (overrides: Record<string, unknown> = {}) => ({
  id: "ai-1",
  text: "Send the sponsor packet to Apex",
  ownerId: "officer-2",
  dueAt: new Date("2026-10-30T05:00:00Z"),
  status: "open",
  doneAt: null,
  meetingId: "m-1",
  roomId: null,
  createdById: "officer-1",
  createdAt: HELD,
  updatedAt: HELD,
  ...overrides,
})

beforeEach(() => {
  db.$transaction.mockImplementation(async (arg: unknown) => (typeof arg === "function" ? arg(db) : Promise.all(arg as Promise<unknown>[])))
  db.$queryRaw.mockResolvedValue([])
  db.meeting.findUnique.mockResolvedValue(meeting())
  db.meeting.create.mockImplementation(async ({ data }) => ({ ...meeting(), ...data, id: "m-new" }))
  db.meeting.update.mockImplementation(async ({ data }) => ({ ...meeting(), ...data }))
  db.meetingDecision.create.mockImplementation(async ({ data }) => ({ id: `d-${data.text.length}`, createdAt: NOW, knowledgeEntryId: null, ...data }))
  db.actionItem.findUnique.mockResolvedValue(item())
  db.actionItem.create.mockImplementation(async ({ data }) => ({ ...item(), ...data, id: "ai-new" }))
  db.actionItem.update.mockImplementation(async ({ data }) => ({ ...item(), ...data }))
  db.user.findMany.mockResolvedValue([{ id: "officer-2" }])
  knowledge.knowledgeSecret.mockReturnValue(null)
  knowledge.createKnowledgeEntry.mockResolvedValue({ ok: true, entry: { id: "k-1" }, versionId: "v-1", changed: true })
})

describe("meetings", () => {
  it("records a meeting, keeping its type in kind, its room and transcript, and audits without its text", async () => {
    const result = await createMeeting({ title: "Board meeting", type: "board", heldAt: HELD, agendaMd: "1. Sponsors", summaryMd: "" }, actor, { transcriptFileId: "f-1", roomId: "room-1" })
    expect(result).toMatchObject({ ok: true, meeting: { id: "m-new" } })
    expect(db.meeting.create.mock.calls[0][0].data).toEqual({ title: "Board meeting", kind: "board", heldAt: HELD, agendaMd: "1. Sponsors", summaryMd: null, transcriptFileId: "f-1", roomId: "room-1", createdById: "officer-1" })
    expect(audit.createAuditLog.mock.calls[0][0].after).toMatchObject({ agenda: true, summary: false })
    expect(JSON.stringify(audit.createAuditLog.mock.calls[0][0])).not.toContain("1. Sponsors")
  })

  it("refuses a meeting without a title or type", async () => {
    expect(await createMeeting({ title: "", type: "board", heldAt: HELD }, actor)).toMatchObject({ ok: false, reason: "invalid" })
    expect(await createMeeting({ title: "Board", type: "party", heldAt: HELD }, actor)).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("changes only what differs, under the row lock, and refuses when what it read moved on", async () => {
    expect(await updateMeeting("m-1", { title: "Board meeting", summaryMd: "We talked sponsors." }, actor)).toMatchObject({ ok: true, changed: ["summaryMd"] })
    expect(db.meeting.update.mock.calls[0][0].data).toEqual({ summaryMd: "We talked sponsors." })

    db.meeting.findUnique.mockResolvedValue(meeting({ summaryMd: "Someone else's summary" }))
    const { updateMeetingTx } = await import("./meeting.service")
    expect(await updateMeetingTx(db as never, "m-1", { summaryMd: "Mine" }, actor, { expected: { summaryMd: null } })).toMatchObject({ ok: false, reason: "changed" })
    expect(db.meeting.update).toHaveBeenCalledTimes(1)
  })

  it("deletes a meeting with its decisions; its action items stay", async () => {
    expect(await deleteMeeting("m-1", actor)).toEqual({ ok: true, title: "Board meeting" })
    expect(db.meetingDecision.deleteMany).toHaveBeenCalledWith({ where: { meetingId: "m-1" } })
    expect(db.meeting.delete).toHaveBeenCalledWith({ where: { id: "m-1" } })
  })
})

describe("decisions and the decision log", () => {
  it("writes the decision, then its log entry: tagged decision, dated the meeting, linked back, reviewed by the officer", async () => {
    const result = await addDecision("m-1", { text: "Keep the four sponsor tiers for 2026-27." }, actor, { roomId: "room-1", now: NOW })
    expect(result).toMatchObject({ ok: true, knowledge: { ok: true, entryId: "k-1" } })
    expect(db.meetingDecision.create.mock.calls[0][0].data).toEqual({ meetingId: "m-1", text: "Keep the four sponsor tiers for 2026-27.", decidedAt: HELD })
    const [fields, writer, options] = knowledge.createKnowledgeEntry.mock.calls[0]
    expect(fields).toEqual({
      title: "Keep the four sponsor tiers for 2026-27",
      body: "Keep the four sponsor tiers for 2026-27.\n\nDecided at Board meeting, Oct 19, 2026.",
      tags: ["decision", "board"],
      sourceNote: "Board meeting (meeting record)",
      sourceDate: HELD,
      sourceUrl: "/admin/meetings/m-1",
      ownerId: null,
    })
    expect(writer).toEqual({ userId: "officer-1", via: "admin", roomId: "room-1" })
    expect(options).toEqual({ skipDuplicateCheck: true, reviewedAt: NOW })
    expect(db.meetingDecision.update).toHaveBeenCalledWith({ where: { id: expect.any(String) }, data: { knowledgeEntryId: "k-1" } })
  })

  it("keeps the decision when its log entry can't be written, saying why", async () => {
    knowledge.createKnowledgeEntry.mockResolvedValue({ ok: false, reason: "invalid", error: "Give the entry a title (3 characters or more)." })
    const [result] = await linkDecisionsToLog(meeting(), [{ decision: { id: "d-1", text: "Yes.", meetingId: "m-1", decidedAt: HELD, knowledgeEntryId: null, createdAt: NOW } }], actor)
    expect(result.knowledge).toEqual({ ok: false, error: "Give the entry a title (3 characters or more)." })
    expect(db.meetingDecision.update).not.toHaveBeenCalled()

    knowledge.createKnowledgeEntry.mockRejectedValue(new Error("connection lost"))
    const [thrown] = await linkDecisionsToLog(meeting(), [{ decision: { id: "d-2", text: "Yes.", meetingId: "m-1", decidedAt: HELD, knowledgeEntryId: null, createdAt: NOW } }], actor)
    expect(thrown.knowledge.ok).toBe(false)
  })

  it("refuses a decision that holds a secret, before writing anything", async () => {
    knowledge.knowledgeSecret.mockReturnValue("a Stripe key")
    expect(decisionProblem({ text: "Use the key for payouts" })).toMatch(/a Stripe key/)
    expect(await addDecision("m-1", { text: "Use the key for payouts" }, actor)).toMatchObject({ ok: false })
    expect(db.meetingDecision.create).not.toHaveBeenCalled()
  })
})

describe("action items", () => {
  it("adds one with an officer owner, on its meeting and room", async () => {
    expect(await createActionItem({ text: "Book the room", ownerId: "officer-2", dueAt: null }, actor, { meetingId: "m-1", roomId: "room-1" })).toMatchObject({ ok: true })
    expect(db.actionItem.create.mock.calls[0][0].data).toEqual({ text: "Book the room", ownerId: "officer-2", dueAt: null, meetingId: "m-1", roomId: "room-1", createdById: "officer-1" })
    db.user.findMany.mockResolvedValue([])
    expect(await createActionItem({ text: "Book the room", ownerId: "member-9" }, actor)).toMatchObject({ ok: false, reason: "owner" })
  })

  it("stamps doneAt when marked done and clears it when reopened", async () => {
    const { updateActionItemTx } = await import("./meeting.service")
    expect(await updateActionItemTx(db as never, "ai-1", { status: "done" }, actor, { now: NOW })).toMatchObject({ ok: true, changed: ["status"] })
    expect(db.actionItem.update.mock.calls[0][0].data).toEqual({ status: "done", doneAt: NOW })
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actionType: "MARK_DONE", entityType: "ACTION_ITEM", targetUserId: "officer-2" })

    db.actionItem.findUnique.mockResolvedValue(item({ status: "done", doneAt: NOW }))
    await updateActionItem("ai-1", { status: "open" }, actor)
    expect(db.actionItem.update.mock.calls[1][0].data).toEqual({ status: "open", doneAt: null })
  })

  it("refuses when what it read moved on, and a non-officer owner", async () => {
    expect(await updateActionItem("ai-1", { status: "done" }, actor, { expected: { status: "dropped" } })).toMatchObject({ ok: false, reason: "changed" })
    db.user.findMany.mockResolvedValue([])
    expect(await updateActionItem("ai-1", { ownerId: "member-9" }, actor)).toMatchObject({ ok: false, reason: "owner" })
    expect(db.actionItem.update).not.toHaveBeenCalled()
  })
})
