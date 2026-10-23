import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  jackRoom: { findUnique: vi.fn() },
  scheduledJob: { create: vi.fn(), update: vi.fn() },
  recurringQuestion: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  user: { findMany: vi.fn() },
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)

import {
  askRecurringQuestionNow,
  createRecurringQuestion,
  deleteRecurringQuestion,
  pauseRecurringQuestion,
  setRecurringQuestionOn,
  snapshotOf,
  updateRecurringQuestionTx,
} from "./service"

const NOW = new Date("2026-10-22T17:00:00Z") // Thu, noon Central
const actor = { userId: "officer-1" }
const fields = { title: "Weekly signups", prompt: "How many people signed up last week?", roomId: "room-1", persona: "jack", schedule: { every: "week", days: ["mon"], time: "09:00" } }

const job = (overrides: Record<string, unknown> = {}) => ({
  id: "job-1",
  key: "recurring:q-1",
  kind: "recurring.question",
  schedule: "0 9 * * 1",
  enabled: false,
  nextRunAt: new Date("2026-10-26T14:00:00Z"),
  ...overrides,
})
const question = (overrides: Record<string, unknown> = {}, jobOverrides: Record<string, unknown> = {}) => ({
  id: "q-1",
  title: "Weekly signups",
  prompt: "How many people signed up last week?",
  roomId: "room-1",
  persona: "jack",
  scheduledJobId: "job-1",
  createdById: "officer-1",
  pausedReason: null,
  lastRunAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  scheduledJob: job(jobOverrides),
  ...overrides,
})

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  db.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(db))
  db.$queryRaw.mockResolvedValue([])
  db.jackRoom.findUnique.mockResolvedValue({ archivedAt: null })
  db.scheduledJob.create.mockImplementation(async ({ data }) => ({ id: "job-new", ...data }))
  db.scheduledJob.update.mockImplementation(async ({ data }) => ({ ...job(), ...data }))
  db.recurringQuestion.create.mockImplementation(async ({ data }) => ({ ...question(), ...data }))
  db.recurringQuestion.findUnique.mockResolvedValue(question())
  db.recurringQuestion.update.mockImplementation(async ({ data }) => ({ ...question(), ...data }))
  db.user.findMany.mockResolvedValue([{ id: "officer-1" }])
})

afterEach(() => {
  vi.useRealTimers()
})

describe("setting up a recurring question", () => {
  it("creates its job and the question together, off by default, keyed by the question's id", async () => {
    const result = await createRecurringQuestion(fields, actor)
    expect(result.ok).toBe(true)
    const jobData = db.scheduledJob.create.mock.calls[0][0].data
    const questionData = db.recurringQuestion.create.mock.calls[0][0].data
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(jobData).toMatchObject({ kind: "recurring.question", schedule: "0 9 * * 1", enabled: false, createdById: "officer-1" })
    expect(jobData.key).toBe(`recurring:${questionData.id}`)
    // Next Monday, 9 AM Central (CDT)
    expect(jobData.nextRunAt).toEqual(new Date("2026-10-26T14:00:00Z"))
    expect(questionData).toMatchObject({ title: "Weekly signups", roomId: "room-1", persona: "jack", scheduledJobId: "job-new", createdById: "officer-1" })
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "CREATE", entityType: "RECURRING_QUESTION", summary: "Set up the recurring question “Weekly signups” (off)" }), db)
  })

  it("can start it on, and run it as someone else (the officer a proposal was for)", async () => {
    await createRecurringQuestion(fields, actor, { enabled: true, createdById: "officer-2" })
    expect(db.scheduledJob.create.mock.calls[0][0].data.enabled).toBe(true)
    expect(db.recurringQuestion.create.mock.calls[0][0].data.createdById).toBe("officer-2")
  })

  it("refuses Lift, a schedule that isn't one of the shapes, and archived or missing rooms", async () => {
    expect(await createRecurringQuestion({ ...fields, persona: "lift" }, actor)).toMatchObject({ ok: false, reason: "invalid" })
    expect(await createRecurringQuestion({ ...fields, schedule: { every: "day", time: "nine" } }, actor)).toMatchObject({ ok: false, reason: "invalid" })
    db.jackRoom.findUnique.mockResolvedValueOnce({ archivedAt: NOW })
    expect(await createRecurringQuestion(fields, actor)).toMatchObject({ ok: false, reason: "room", error: expect.stringMatching(/archived/) })
    db.jackRoom.findUnique.mockResolvedValueOnce(null)
    expect(await createRecurringQuestion(fields, actor)).toMatchObject({ ok: false, reason: "room", error: expect.stringMatching(/doesn't exist/) })
    expect(db.scheduledJob.create).not.toHaveBeenCalled()
  })
})

describe("changing one", () => {
  it("changes only what differs, and moves the next run only while it's on", async () => {
    const off = await updateRecurringQuestionTx(db as never, "q-1", { title: "Weekly signups", schedule: { every: "day", time: "08:00" } }, actor)
    expect(off).toMatchObject({ ok: true, changed: ["schedule"] })
    expect(db.recurringQuestion.update).not.toHaveBeenCalled()
    expect(db.scheduledJob.update.mock.calls[0][0].data).toEqual({ schedule: "0 8 * * *", updatedById: "officer-1" })

    db.recurringQuestion.findUnique.mockResolvedValue(question({}, { enabled: true }))
    await updateRecurringQuestionTx(db as never, "q-1", { schedule: { every: "day", time: "08:00" }, persona: "stand" }, actor)
    expect(db.recurringQuestion.update.mock.calls[0][0].data).toEqual({ persona: "stand" })
    expect(db.scheduledJob.update.mock.calls[1][0].data.nextRunAt).toEqual(new Date("2026-10-23T13:00:00Z"))
  })

  it("locks the rows, and refuses when what a proposal read moved on", async () => {
    db.recurringQuestion.findUnique.mockResolvedValue(question({ prompt: "Someone else's wording" }))
    const result = await updateRecurringQuestionTx(db as never, "q-1", { title: "Signups" }, actor, { expected: snapshotOf(question() as never) })
    expect(result).toMatchObject({ ok: false, reason: "changed", error: expect.stringMatching(/prompt/) })
    expect(db.$queryRaw).toHaveBeenCalledTimes(2)
    expect(db.recurringQuestion.update).not.toHaveBeenCalled()
  })

  it("says so when it's gone", async () => {
    db.recurringQuestion.findUnique.mockResolvedValue(null)
    expect(await updateRecurringQuestionTx(db as never, "q-1", { title: "x" }, actor)).toMatchObject({ ok: false, reason: "not_found" })
  })
})

describe("switching", () => {
  it("turns it on from now, clears a pause reason, and leaves the owner while they're an officer", async () => {
    db.recurringQuestion.findUnique.mockResolvedValue(question({ pausedReason: "its room is archived" }))
    const result = await setRecurringQuestionOn("q-1", true, actor)
    expect(result).toMatchObject({ ok: true, changed: ["enabled"] })
    expect(db.scheduledJob.update.mock.calls[0][0].data).toMatchObject({ enabled: true, nextRunAt: new Date("2026-10-26T14:00:00Z") })
    expect(db.recurringQuestion.update.mock.calls[0][0].data).toEqual({ pausedReason: null })
  })

  it("makes whoever turns it back on its owner when the owner isn't an officer any more", async () => {
    db.recurringQuestion.findUnique.mockResolvedValue(question({ createdById: "left-1", pausedReason: "Sam isn't an officer any more" }))
    db.user.findMany.mockResolvedValue([])
    const result = await setRecurringQuestionOn("q-1", true, { userId: "officer-2" })
    expect(result).toMatchObject({ ok: true, changed: ["enabled", "createdById"] })
    expect(db.recurringQuestion.update.mock.calls[0][0].data).toEqual({ pausedReason: null, createdById: "officer-2" })
    expect(audit.createAuditLog.mock.calls[0][0].summary).toMatch(/took it over/)
  })

  it("won't turn one on in an archived room", async () => {
    db.jackRoom.findUnique.mockResolvedValue({ archivedAt: NOW })
    expect(await setRecurringQuestionOn("q-1", true, actor)).toMatchObject({ ok: false, reason: "room", error: expect.stringMatching(/Unarchive/) })
  })

  it("pauses itself only while it's still on, with the reason, and audits it as nobody", async () => {
    db.recurringQuestion.findUnique.mockResolvedValue(question({}, { enabled: true }))
    expect(await pauseRecurringQuestion("q-1", "its room is archived")).toBe(true)
    expect(db.scheduledJob.update.mock.calls[0][0].data).toEqual({ enabled: false })
    expect(db.recurringQuestion.update.mock.calls[0][0].data).toEqual({ pausedReason: "its room is archived" })
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: null, actionType: "PAUSE" })

    db.recurringQuestion.findUnique.mockResolvedValue(question())
    expect(await pauseRecurringQuestion("q-1", "again")).toBe(false)
  })
})

describe("deleting and asking now", () => {
  it("deletes the question (its job goes with it) and audits what it was, in one transaction", async () => {
    db.recurringQuestion.deleteMany.mockResolvedValue({ count: 1 })
    expect(await deleteRecurringQuestion("q-1", actor)).toEqual({ ok: true, title: "Weekly signups" })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$queryRaw).toHaveBeenCalled()
    expect(db.recurringQuestion.deleteMany).toHaveBeenCalledWith({ where: { id: "q-1" } })
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actionType: "DELETE", before: { title: "Weekly signups", schedule: "0 9 * * 1" } })
    expect(audit.createAuditLog.mock.calls[0][1]).toBe(db)
  })

  it("says it's gone, without an audit entry, when another delete got there first", async () => {
    db.recurringQuestion.findUnique.mockResolvedValue(null)
    expect(await deleteRecurringQuestion("q-1", actor)).toEqual({ ok: false, error: expect.stringMatching(/doesn't exist anymore/) })
    db.recurringQuestion.findUnique.mockResolvedValue(question())
    db.recurringQuestion.deleteMany.mockResolvedValue({ count: 0 })
    expect(await deleteRecurringQuestion("q-1", actor)).toEqual({ ok: false, error: expect.stringMatching(/doesn't exist anymore/) })
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("asks one that's on at the next tick, and refuses one that's off", async () => {
    expect(await askRecurringQuestionNow("q-1", actor)).toMatchObject({ ok: false, error: expect.stringMatching(/Turn it on first/) })
    db.recurringQuestion.findUnique.mockResolvedValue(question({}, { enabled: true }))
    expect(await askRecurringQuestionNow("q-1", actor, NOW)).toEqual({ ok: true, title: "Weekly signups" })
    expect(db.scheduledJob.update).toHaveBeenCalledWith({ where: { id: "job-1" }, data: { nextRunAt: NOW, updatedById: "officer-1" } })
  })
})
