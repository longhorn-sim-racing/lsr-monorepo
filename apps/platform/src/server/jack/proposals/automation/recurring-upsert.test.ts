import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  recurringQuestion: { findUnique: vi.fn() },
  jackRoom: { findUnique: vi.fn() },
  jackMessage: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
}))
const service = vi.hoisted(() => ({ createRecurringQuestionTx: vi.fn(), updateRecurringQuestionTx: vi.fn(), setRecurringQuestionOnTx: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/automation/recurring/service", async (original) => ({ ...(await original<typeof import("@/server/automation/recurring/service")>()), ...service }))

import { StaleProposalError } from "../errors"
import { recurringUpsertKind, recurringUpsertSchema } from "./recurring-upsert"

const ctx = { roomId: "room-here", officer: { userId: "gray", displayName: "Gray" } }
const weekly = { every: "week" as const, days: ["mon" as const], time: "09:00" }
const create = { title: "Weekly signups", prompt: "How many people signed up last week?", schedule: weekly }
const question = (overrides: Record<string, unknown> = {}, job: Record<string, unknown> = {}) => ({
  id: "q-1",
  title: "Weekly signups",
  prompt: "How many people signed up last week?",
  roomId: "room-here",
  persona: "jack",
  scheduledJobId: "job-1",
  createdById: "gray",
  scheduledJob: { id: "job-1", key: "recurring:q-1", schedule: "0 9 * * 1", enabled: false, ...job },
  ...overrides,
})
const applyCtx = (before: unknown, proposedFor: string | null = "gray") => ({
  officer: { userId: "dylan", displayName: "Dylan" },
  proposalId: "p-1",
  roomId: "room-here",
  idempotencyKey: "proposal:p-1",
  before,
  auditMetadata: { via: "jack" as const, proposalId: "p-1", roomId: "room-here", proposedFor },
})

beforeEach(() => {
  db.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(db))
  db.recurringQuestion.findUnique.mockResolvedValue(question())
  db.jackRoom.findUnique.mockResolvedValue({ title: "Signups room", archivedAt: null })
  db.jackMessage.findMany.mockResolvedValue([])
  db.user.findMany.mockResolvedValue([{ id: "gray" }])
  service.createRecurringQuestionTx.mockResolvedValue({ ok: true, question: question(), changed: ["title"] })
  service.updateRecurringQuestionTx.mockResolvedValue({ ok: true, question: question(), changed: ["prompt"] })
  service.setRecurringQuestionOnTx.mockResolvedValue({ ok: true, question: question({}, { enabled: true }), changed: ["enabled"] })
})

describe("recurring.upsert's input", () => {
  it("needs a title, question and schedule for a new one, and takes only the changes for an edit", () => {
    expect(recurringUpsertSchema.safeParse(create).success).toBe(true)
    expect(recurringUpsertSchema.safeParse({ title: "x", prompt: "y" }).error?.issues[0]).toMatchObject({ path: ["schedule"] })
    expect(recurringUpsertSchema.safeParse({ id: "q-1", on: true }).success).toBe(true)
  })

  it("refuses a schedule that could run more than once a day, and Lift", () => {
    expect(recurringUpsertSchema.safeParse({ ...create, schedule: { every: "day", time: "9" } }).success).toBe(false)
    expect(recurringUpsertSchema.safeParse({ ...create, schedule: { every: "hourly", time: "09:00" } }).success).toBe(false)
    expect(recurringUpsertSchema.safeParse({ ...create, persona: "lift" }).success).toBe(false)
  })
})

describe("proposing a new one", () => {
  it("describes it on the server, in this room by default, off, with its estimated monthly cost", async () => {
    const prepared = await recurringUpsertKind.prepare(recurringUpsertSchema.parse(create), ctx)
    expect(prepared.before).toBeNull()
    expect(prepared.targetId).toBeUndefined()
    expect(prepared.view.title).toBe("Set up the recurring question “Weekly signups”")
    // Sonnet's typical run: 4.35 Mondays a month at about $0.12
    expect(prepared.view.summary).toBe(
      "Asks it in “Signups room” (Mondays at 9:00 AM CT), answered by Jack as Gray with no web search. About $0.52 a month (4 runs at about $0.12, a typical run), counted toward automations' $10 a month. It starts off: turn it on on Jack → Recurring questions.",
    )
    expect(prepared.view.diff.map((row) => [row.label, row.after])).toEqual([
      ["Title", "Weekly signups"],
      ["Question", "How many people signed up last week?"],
      ["Room", "Signups room"],
      ["When", "Mondays at 9:00 AM CT"],
      ["Answered by", "Jack"],
      ["On", "Off"],
      ["Estimated cost", "$0.52 a month"],
    ])
    expect(db.jackRoom.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "room-here" } }))
  })

  it("refuses an archived or missing room for the model to fix", async () => {
    db.jackRoom.findUnique.mockResolvedValue({ archivedAt: new Date() })
    await expect(recurringUpsertKind.prepare(recurringUpsertSchema.parse(create), ctx)).rejects.toThrow("That room is archived; pick another.")
    db.jackRoom.findUnique.mockResolvedValue(null)
    await expect(recurringUpsertKind.prepare(recurringUpsertSchema.parse({ ...create, roomId: "nope" }), ctx)).rejects.toThrow("There's no room with id nope.")
  })

  it("applies through the service, running as the officer it was proposed for, and starts it on only when asked", async () => {
    const result = await recurringUpsertKind.apply(recurringUpsertSchema.parse({ ...create, on: true, persona: "stand" }), applyCtx(null))
    const [, fields, actor, options] = service.createRecurringQuestionTx.mock.calls[0]
    expect(fields).toEqual({ title: "Weekly signups", prompt: "How many people signed up last week?", schedule: weekly, persona: "stand", roomId: "room-here" })
    expect(actor).toEqual({ userId: "dylan", auditMetadata: expect.objectContaining({ proposalId: "p-1" }) })
    expect(options).toEqual({ createdById: "gray", enabled: true })
    expect(result).toMatchObject({ links: [{ url: "/admin/jack/recurring?q=q-1" }], created: [{ type: "RECURRING_QUESTION", id: "q-1" }] })
  })

  it("runs as whoever applied it when the officer it was for isn't one any more", async () => {
    db.user.findMany.mockResolvedValue([])
    await recurringUpsertKind.apply(recurringUpsertSchema.parse(create), applyCtx(null))
    expect(service.createRecurringQuestionTx.mock.calls[0][3]).toEqual({ createdById: "dylan", enabled: false })
  })

  it("goes stale when its room was archived since", async () => {
    service.createRecurringQuestionTx.mockResolvedValue({ ok: false, reason: "room", error: "That room is archived." })
    await expect(recurringUpsertKind.apply(recurringUpsertSchema.parse(create), applyCtx(null))).rejects.toBeInstanceOf(StaleProposalError)
  })
})

describe("proposing a change", () => {
  it("shows only what changes, and snapshots the question for the staleness check", async () => {
    const prepared = await recurringUpsertKind.prepare(recurringUpsertSchema.parse({ id: "q-1", schedule: { every: "day", time: "08:00" }, on: true }), ctx)
    expect(prepared.targetId).toBe("q-1")
    expect(prepared.before).toEqual({ title: "Weekly signups", prompt: "How many people signed up last week?", roomId: "room-here", persona: "jack", schedule: "0 9 * * 1", enabled: false })
    expect(prepared.view.diff).toEqual([
      { field: "schedule", label: "When", before: "Mondays at 9:00 AM CT", after: "Daily at 8:00 AM CT", format: "value" },
      { field: "enabled", label: "On", before: "Off", after: "On", format: "value" },
    ])
    expect(prepared.view.summary).toMatch(/About \$3\.\d\d a month \(30 runs/)
  })

  it("refuses a change that changes nothing, or a question that isn't there", async () => {
    await expect(recurringUpsertKind.prepare(recurringUpsertSchema.parse({ id: "q-1", title: "Weekly signups" }), ctx)).rejects.toThrow(/Nothing would change/)
    db.recurringQuestion.findUnique.mockResolvedValue(null)
    await expect(recurringUpsertKind.prepare(recurringUpsertSchema.parse({ id: "q-9", on: true }), ctx)).rejects.toThrow(/no recurring question with id q-9/)
  })

  it("is stale once the question changed or was deleted", async () => {
    const before = { title: "Weekly signups", prompt: "How many people signed up last week?", roomId: "room-here", persona: "jack", schedule: "0 9 * * 1", enabled: false }
    const p = recurringUpsertSchema.parse({ id: "q-1", on: true })
    expect(await recurringUpsertKind.checkStale(p, before)).toBeNull()
    db.recurringQuestion.findUnique.mockResolvedValue(question({}, { enabled: true }))
    expect(await recurringUpsertKind.checkStale(p, before)).toBe("“Weekly signups” changed since this was proposed (enabled).")
    db.recurringQuestion.findUnique.mockResolvedValue(null)
    expect(await recurringUpsertKind.checkStale(p, before)).toMatch(/deleted/)
  })

  it("applies the fields and the switch in one transaction, against the snapshot", async () => {
    const before = { title: "Weekly signups", prompt: "Old?", roomId: "room-here", persona: "jack", schedule: "0 9 * * 1", enabled: false }
    const result = await recurringUpsertKind.apply(recurringUpsertSchema.parse({ id: "q-1", prompt: "New?", on: true }), applyCtx(before))
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(service.updateRecurringQuestionTx).toHaveBeenCalledWith(db, "q-1", { prompt: "New?" }, expect.objectContaining({ userId: "dylan" }), { expected: before })
    expect(service.setRecurringQuestionOnTx).toHaveBeenCalledWith(db, "q-1", true, expect.objectContaining({ userId: "dylan" }))
    expect(result.summary).toBe("Changed the recurring question “Weekly signups”.")

    service.updateRecurringQuestionTx.mockResolvedValue({ ok: false, reason: "changed", error: "It changed." })
    await expect(recurringUpsertKind.apply(recurringUpsertSchema.parse({ id: "q-1", prompt: "New?" }), applyCtx(before))).rejects.toBeInstanceOf(StaleProposalError)
  })
})
