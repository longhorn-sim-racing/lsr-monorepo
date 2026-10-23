import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  recurringQuestion: { findUnique: vi.fn(), updateMany: vi.fn() },
  jackMessage: { findMany: vi.fn(), count: vi.fn() },
  user: { findMany: vi.fn() },
}))
const service = vi.hoisted(() => ({ pauseRecurringQuestion: vi.fn() }))
const notes = vi.hoisted(() => ({ postAutomationNote: vi.fn() }))
const answer = vi.hoisted(() => ({ answerScheduledNote: vi.fn(), retryJobAt: vi.fn(), defaultRunRoom: vi.fn(), RETRY_AFTER_MS: 180_000, RETRY_WINDOW_MS: 2_700_000 }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("./service", () => service)
vi.mock("../notes", () => notes)
vi.mock("../answer", () => answer)
vi.mock("@/server/jack/broadcast", () => ({ broadcastRoomEvent: vi.fn() }))
vi.mock("../cap", () => ({ automationBudget: vi.fn() }))

import type { AutomationBudget } from "../cap"
import { askText, runRecurringQuestion, type RecurringRunDeps } from "./run"

const NOW = new Date("2026-10-26T14:00:00Z") // Mon, 9 AM Central
const ctx = { job: { id: "job-1", key: "recurring:q-1" }, startedAt: NOW.getTime(), log: vi.fn() }
const budget = (stopped: AutomationBudget["stopped"] = null): AutomationBudget => ({ month: "October", spentUsd: stopped === "automation_cap" ? 10.2 : 1, capUsd: 10, totalUsd: 20, budgetUsd: 50, stopped })

const question = (overrides: Record<string, unknown> = {}) => ({
  id: "q-1",
  title: "Weekly signups",
  prompt: "How many people signed up last week?",
  roomId: "room-1",
  persona: "jack",
  createdById: "gray",
  createdBy: { id: "gray", displayName: "Gray" },
  room: { id: "room-1", archivedAt: null },
  ...overrides,
})

let deps: RecurringRunDeps

beforeEach(() => {
  deps = { broadcast: vi.fn(), runRoom: vi.fn(), budget: vi.fn(async () => budget()), now: () => NOW }
  db.recurringQuestion.findUnique.mockResolvedValue(question())
  db.recurringQuestion.updateMany.mockResolvedValue({ count: 1 })
  db.jackMessage.findMany.mockResolvedValue([])
  db.jackMessage.count.mockResolvedValue(0)
  db.user.findMany.mockResolvedValue([{ id: "gray" }])
  service.pauseRecurringQuestion.mockResolvedValue(true)
  notes.postAutomationNote.mockImplementation(async (note) => ({ id: "note-1", roomId: note.roomId, createdAt: NOW }))
  answer.answerScheduledNote.mockResolvedValue({ answer: { id: "reply-1", status: "done", costUsd: 0.041 } })
  answer.retryJobAt.mockResolvedValue(true)
})

describe("a recurring question's run", () => {
  it("asks it as a scheduled note from its owner, has the room answer it, and says what it cost", async () => {
    const result = await runRecurringQuestion(ctx, deps)
    expect(notes.postAutomationNote).toHaveBeenCalledTimes(1)
    expect(notes.postAutomationNote.mock.calls[0][0]).toEqual({
      roomId: "room-1",
      jobKey: "recurring:q-1",
      content: "Recurring question “Weekly signups” (set up by Gray): How many people signed up last week?",
      scheduled: true,
      authorUserId: "gray",
    })
    expect(db.recurringQuestion.updateMany).toHaveBeenCalledWith({ where: { id: "q-1" }, data: { lastRunAt: NOW, pausedReason: null } })
    expect(answer.answerScheduledNote).toHaveBeenCalledWith({ id: "note-1", roomId: "room-1", createdAt: NOW }, NOW.getTime(), deps.runRoom)
    expect(result).toEqual({ summary: "Asked “Weekly signups”; answered ($0.04) → /admin/jack/room-1?m=reply-1" })
  })

  it("checks the budget against the run's own time", async () => {
    await runRecurringQuestion(ctx, deps)
    expect(deps.budget).toHaveBeenCalledWith(NOW)
  })

  it("pauses it, with a room note, when its room is archived", async () => {
    db.recurringQuestion.findUnique.mockResolvedValue(question({ room: { id: "room-1", archivedAt: NOW } }))
    const result = await runRecurringQuestion(ctx, deps)
    expect(service.pauseRecurringQuestion).toHaveBeenCalledWith("q-1", "its room is archived")
    expect(notes.postAutomationNote.mock.calls[0][0]).toMatchObject({ scheduled: false, content: expect.stringMatching(/^Paused the recurring question “Weekly signups”: this room is archived\..* → \/admin\/jack\/recurring$/) })
    expect(result).toMatchObject({ status: "skipped" })
    expect(answer.answerScheduledNote).not.toHaveBeenCalled()
  })

  it("pauses it, with a note, when its owner isn't an officer any more or deleted their account", async () => {
    db.user.findMany.mockResolvedValue([])
    expect(await runRecurringQuestion(ctx, deps)).toEqual({ status: "skipped", summary: "Paused “Weekly signups”: Gray isn't an officer any more." })
    expect(notes.postAutomationNote.mock.calls[0][0].content).toMatch(/Gray isn't an officer any more\. Another officer can turn it back on/)

    db.recurringQuestion.findUnique.mockResolvedValue(question({ createdById: null, createdBy: null }))
    expect(await runRecurringQuestion(ctx, deps)).toMatchObject({ summary: expect.stringMatching(/deleted their account/) })
    expect(service.pauseRecurringQuestion).toHaveBeenLastCalledWith("q-1", "the officer who set it up deleted their account")
  })

  it("posts no pause note when an officer switched it off meanwhile", async () => {
    db.recurringQuestion.findUnique.mockResolvedValue(question({ room: { id: "room-1", archivedAt: NOW } }))
    service.pauseRecurringQuestion.mockResolvedValue(false)
    await runRecurringQuestion(ctx, deps)
    expect(notes.postAutomationNote).not.toHaveBeenCalled()
  })

  it("skips it at the automation cap, saying so in the room once a month", async () => {
    deps.budget = vi.fn(async () => budget("automation_cap"))
    expect(await runRecurringQuestion(ctx, deps)).toEqual({ status: "skipped", summary: "Skipped: automations used this month's $10." })
    expect(notes.postAutomationNote.mock.calls[0][0]).toMatchObject({ scheduled: false, content: expect.stringMatching(/^Skipped the recurring question “Weekly signups”: automations .* this month's \$10\. .* → \/admin\/jack\/usage$/) })
    expect(db.jackMessage.count.mock.calls[0][0].where).toMatchObject({ roomId: "room-1", jobKey: "recurring:q-1", scheduled: false, content: { startsWith: "Skipped the recurring question" }, createdAt: { gte: new Date("2026-10-01T05:00:00Z") } })

    db.jackMessage.count.mockResolvedValue(1)
    await runRecurringQuestion(ctx, deps)
    expect(notes.postAutomationNote).toHaveBeenCalledTimes(1)
    expect(answer.answerScheduledNote).not.toHaveBeenCalled()
  })

  it("skips it when Jack's whole budget is used up", async () => {
    deps.budget = vi.fn(async () => budget("monthly_budget"))
    expect(await runRecurringQuestion(ctx, deps)).toMatchObject({ status: "skipped", summary: "Skipped: Jack's monthly budget is used up." })
    expect(notes.postAutomationNote.mock.calls[0][0].content).toMatch(/Jack's monthly budget is used up/)
  })

  it("looks again in a few minutes when the room is busy, without asking twice", async () => {
    answer.answerScheduledNote.mockResolvedValue({ answer: null, busy: true })
    const first = await runRecurringQuestion(ctx, deps)
    expect(answer.retryJobAt).toHaveBeenCalledWith("job-1", new Date(NOW.getTime() + 180_000))
    expect(first.summary).toBe("Asked “Weekly signups”; the room is busy with another answer, so it looks again at 9:03 AM CT.")

    // The retry finds its note still waiting: it gets that answered instead of posting another
    db.jackMessage.findMany.mockResolvedValue([{ id: "note-1", roomId: "room-1", createdAt: new Date(NOW.getTime() - 180_000) }])
    answer.answerScheduledNote.mockResolvedValue({ answer: { id: "reply-1", status: "streaming", costUsd: 0.01 } })
    const second = await runRecurringQuestion(ctx, deps)
    expect(notes.postAutomationNote).toHaveBeenCalledTimes(1)
    expect(deps.budget).toHaveBeenCalledTimes(1)
    expect(second.summary).toBe("Asked “Weekly signups”; Jack is answering → /admin/jack/room-1?m=reply-1")
    expect(db.jackMessage.findMany.mock.calls[1][0].where).toMatchObject({ roomId: "room-1", jobKey: "recurring:q-1", scheduled: true, answeredById: null, createdAt: { gte: new Date(NOW.getTime() - 2_700_000) } })
  })

  it("stops looking once its note has waited out the window, leaving it for the room", async () => {
    db.jackMessage.findMany.mockResolvedValue([{ id: "note-1", roomId: "room-1", createdAt: new Date(NOW.getTime() - 2_700_000) }])
    answer.answerScheduledNote.mockResolvedValue({ answer: null, busy: false })
    const result = await runRecurringQuestion(ctx, deps)
    expect(answer.retryJobAt).not.toHaveBeenCalled()
    expect(result.summary).toMatch(/waits in the room \(Continue there answers it\) → \/admin\/jack\/room-1\?m=note-1$/)
  })

  it("is skipped when its question is gone", async () => {
    db.recurringQuestion.findUnique.mockResolvedValue(null)
    expect(await runRecurringQuestion(ctx, deps)).toEqual({ status: "skipped", summary: "Its recurring question is gone." })
  })
})

describe("the note", () => {
  it("names the question and who set it up", () => {
    expect(askText({ title: "Signups", prompt: "How many?" }, "Dylan")).toBe("Recurring question “Signups” (set up by Dylan): How many?")
  })
})
