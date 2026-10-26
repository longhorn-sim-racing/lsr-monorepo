import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  sponsorProspect: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  sponsorActivity: { create: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
  user: { findMany: vi.fn() },
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)

import { createProspect, deleteProspect, deleteProspectActivity, logProspectActivity, updateProspect } from "./sponsor.service"

const NOW = new Date("2026-10-22T17:00:00Z")
const actor = { userId: "officer-1", auditMetadata: { via: "jack", proposalId: "p1", roomId: "room-1", proposedFor: "officer-2" } }

const prospect = (overrides: Record<string, unknown> = {}) => ({
  id: "pr-1",
  company: "Apex Sim Rigs",
  website: null,
  contactName: "Jordan Lee",
  contactEmail: "jordan@apexsimrigs.example",
  contactRole: "Partnerships",
  stage: "contacted",
  tierInterest: null,
  ownerId: null,
  lastContactAt: new Date("2026-10-01T17:00:00Z"),
  nextStep: null,
  nextStepDue: null,
  notes: "Met at the expo",
  createdById: "officer-1",
  createdAt: new Date("2026-09-01T17:00:00Z"),
  updatedAt: new Date("2026-10-01T17:00:00Z"),
  ...overrides,
})

beforeEach(() => {
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db))
  db.$queryRaw.mockResolvedValue([])
  db.sponsorProspect.findMany.mockResolvedValue([])
  db.sponsorProspect.findUnique.mockResolvedValue(prospect())
  db.sponsorProspect.create.mockImplementation(async ({ data }) => ({ ...prospect(), ...data, id: "pr-new" }))
  db.sponsorProspect.update.mockImplementation(async ({ data }) => ({ ...prospect(), ...data }))
  db.sponsorActivity.create.mockImplementation(async ({ data }) => ({ id: "act-1", createdAt: NOW, ...data }))
  db.user.findMany.mockResolvedValue([{ id: "officer-2" }])
})

describe("createProspect", () => {
  it("adds a prospect and audits it without the contact's details or notes", async () => {
    const result = await createProspect({ company: "Bolt Energy", website: "bolt.example", contactEmail: "sam@bolt.example", notes: "Warm lead", ownerId: "officer-2" }, actor)
    expect(result).toMatchObject({ ok: true, prospect: { id: "pr-new", company: "Bolt Energy", website: "https://bolt.example/" } })
    expect(db.sponsorProspect.create.mock.calls[0][0].data).toMatchObject({ company: "Bolt Energy", contactEmail: "sam@bolt.example", ownerId: "officer-2", createdById: "officer-1" })
    const entry = audit.createAuditLog.mock.calls[0][0]
    expect(entry).toMatchObject({ actionType: "CREATE", entityType: "SPONSOR_PROSPECT", entityId: "pr-new", metadata: actor.auditMetadata })
    expect(JSON.stringify(entry.after)).not.toMatch(/sam@bolt|Warm lead/)
  })

  it("refuses a company that's already a prospect, a non-officer owner and bad fields", async () => {
    db.sponsorProspect.findMany.mockResolvedValue([{ id: "pr-1", company: "Bolt Energy, Inc." }])
    expect(await createProspect({ company: "bolt energy" }, actor)).toMatchObject({ ok: false, reason: "duplicate", duplicateId: "pr-1" })
    db.sponsorProspect.findMany.mockResolvedValue([])
    db.user.findMany.mockResolvedValue([])
    expect(await createProspect({ company: "Bolt", ownerId: "member-9" }, actor)).toMatchObject({ ok: false, reason: "owner" })
    expect(await createProspect({ company: "Bolt", contactEmail: "nope" }, actor)).toMatchObject({ ok: false, reason: "invalid" })
    expect(db.sponsorProspect.create).not.toHaveBeenCalled()
  })
})

describe("updateProspect", () => {
  it("changes only the fields that differ, locks the row, and logs a stage change", async () => {
    const result = await updateProspect("pr-1", { stage: "talking", contactName: "Jordan Lee", nextStep: "Send the packet" }, actor)
    expect(result).toMatchObject({ ok: true, changed: ["stage", "nextStep"] })
    expect(db.$queryRaw).toHaveBeenCalled()
    expect(db.sponsorProspect.update.mock.calls[0][0]).toEqual({ where: { id: "pr-1" }, data: { stage: "talking", nextStep: "Send the packet" } })
    expect(db.sponsorActivity.create.mock.calls[0][0].data).toMatchObject({ prospectId: "pr-1", type: "stage_change", summary: "Stage: Contacted → Talking", byId: "officer-1" })
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actionType: "UPDATE", metadata: { ...actor.auditMetadata, changedFields: ["stage", "nextStep"] } })
    // The next step is named as changed, but its text (it often names or addresses the contact) stays out
    expect(audit.createAuditLog.mock.calls[0][0].after).toEqual({ stage: "talking" })
    expect(JSON.stringify(audit.createAuditLog.mock.calls[0][0])).not.toContain("Send the packet")
  })

  it("refuses when a field it was read with moved on, and changes nothing", async () => {
    db.sponsorProspect.findUnique.mockResolvedValue(prospect({ stage: "talking" }))
    expect(await updateProspect("pr-1", { stage: "committed" }, actor, { expected: { stage: "contacted" } })).toMatchObject({ ok: false, reason: "changed" })
    expect(db.sponsorProspect.update).not.toHaveBeenCalled()
  })

  it("does nothing when nothing differs, and says when the prospect is gone", async () => {
    expect(await updateProspect("pr-1", { stage: "contacted" }, actor)).toMatchObject({ ok: true, changed: [] })
    expect(db.sponsorProspect.update).not.toHaveBeenCalled()
    db.sponsorProspect.findUnique.mockResolvedValue(null)
    expect(await updateProspect("pr-1", { stage: "talking" }, actor)).toMatchObject({ ok: false, reason: "not_found" })
  })

  it("refuses renaming to a company that's already a prospect", async () => {
    db.sponsorProspect.findMany.mockResolvedValue([{ id: "pr-2", company: "Bolt" }])
    expect(await updateProspect("pr-1", { company: "BOLT" }, actor)).toMatchObject({ ok: false, reason: "duplicate", duplicateId: "pr-2" })
  })
})

describe("logProspectActivity", () => {
  it("logs contact and moves the last contact forward", async () => {
    const at = new Date("2026-10-20T17:00:00Z")
    const result = await logProspectActivity("pr-1", { type: "meeting", summary: "Intro call with Jordan", occurredAt: at }, actor, { byId: "officer-2" })
    expect(result).toMatchObject({ ok: true })
    expect(db.sponsorActivity.create.mock.calls[0][0].data).toEqual({ prospectId: "pr-1", type: "meeting", summary: "Intro call with Jordan", occurredAt: at, byId: "officer-2" })
    expect(db.sponsorProspect.update.mock.calls[0][0].data).toEqual({ lastContactAt: at })
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actionType: "LOG_ACTIVITY", summary: "Logged a meeting for sponsor prospect: Apex Sim Rigs" })
  })

  it("leaves the last contact for a note, or for contact older than it", async () => {
    await logProspectActivity("pr-1", { type: "note", summary: "Budget opens in January", occurredAt: NOW }, actor)
    await logProspectActivity("pr-1", { type: "email_sent", summary: "Old email", occurredAt: new Date("2026-09-15T17:00:00Z") }, actor)
    expect(db.sponsorProspect.update).not.toHaveBeenCalled()
  })

  it("moves the stage and next step too, logging the stage change", async () => {
    const due = new Date("2026-10-30T05:00:00Z")
    const result = await logProspectActivity("pr-1", { type: "reply", summary: "They're interested", occurredAt: NOW }, actor, { stage: "talking", nextStep: "Send the packet", nextStepDue: due, now: NOW })
    expect(result).toMatchObject({ ok: true, changed: ["stage", "nextStep", "nextStepDue"] })
    expect(db.sponsorProspect.update.mock.calls[0][0].data).toEqual({ stage: "talking", nextStep: "Send the packet", nextStepDue: due, lastContactAt: NOW })
    expect(db.sponsorActivity.create.mock.calls.map((c) => c[0].data.type)).toEqual(["reply", "stage_change"])
  })

  it("refuses a change based on a stage that moved on", async () => {
    db.sponsorProspect.findUnique.mockResolvedValue(prospect({ stage: "committed" }))
    expect(await logProspectActivity("pr-1", { type: "call", summary: "x", occurredAt: NOW }, actor, { stage: "talking", expected: { stage: "contacted" } })).toMatchObject({ ok: false, reason: "changed" })
    expect(db.sponsorActivity.create).not.toHaveBeenCalled()
  })
})

describe("deleting", () => {
  it("removes an activity, but not a stage change", async () => {
    db.sponsorActivity.findUnique.mockResolvedValue({ id: "act-1", type: "call", occurredAt: NOW, prospect: { id: "pr-1", company: "Apex Sim Rigs" } })
    expect(await deleteProspectActivity("act-1", actor)).toEqual({ ok: true, prospectId: "pr-1" })
    db.sponsorActivity.findUnique.mockResolvedValue({ id: "act-2", type: "stage_change", occurredAt: NOW, prospect: { id: "pr-1", company: "Apex Sim Rigs" } })
    expect(await deleteProspectActivity("act-2", actor)).toMatchObject({ ok: false })
    expect(db.sponsorActivity.delete).toHaveBeenCalledTimes(1)
  })

  it("deletes a prospect, keeping only its company and stage in the audit log", async () => {
    expect(await deleteProspect("pr-1", actor)).toEqual({ ok: true, company: "Apex Sim Rigs" })
    expect(db.sponsorProspect.delete).toHaveBeenCalledWith({ where: { id: "pr-1" } })
    expect(audit.createAuditLog.mock.calls[0][0].before).toEqual({ company: "Apex Sim Rigs", stage: "contacted" })
  })
})
