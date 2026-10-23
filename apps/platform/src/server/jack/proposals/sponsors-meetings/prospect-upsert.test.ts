import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ $transaction: vi.fn(), sponsorProspect: { findMany: vi.fn() } }))
const officers = vi.hoisted(() => ({ officersByHandle: vi.fn(), userNames: vi.fn() }))
const service = vi.hoisted(() => ({ createProspectTx: vi.fn(), updateProspectTx: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/officers", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/officers")>()), ...officers }))
vi.mock("@/server/services/sponsor.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/sponsor.service")>()), ...service }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { prospectUpsertKind, prospectUpsertSchema } from "./prospect-upsert"

const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u-ana", displayName: "Ana" } }
const audit = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u-ana" }
const applyCtx = (before: unknown, selectedRows?: string[]): ProposalApplyContext => ({ officer: { userId: "u-gray", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: audit, selectedRows })

const DYLAN = { id: "u-dylan", displayName: "Dylan", handle: "dylan" }
const apex = {
  id: "pr-apex",
  company: "Apex Sim Rigs",
  website: null,
  contactName: "Jordan Lee",
  contactEmail: null,
  contactRole: null,
  stage: "contacted",
  tierInterest: null,
  ownerId: null,
  lastContactAt: null,
  nextStep: null,
  nextStepDue: null,
  notes: null,
  createdById: null,
  createdAt: new Date("2026-09-01T17:00:00Z"),
  updatedAt: new Date("2026-09-01T17:00:00Z"),
}
const crest = { ...apex, id: "pr-crest", company: "Crest Wheels", contactName: "Sam Rivera" }

beforeEach(() => {
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db))
  db.sponsorProspect.findMany.mockResolvedValue([apex, crest])
  officers.officersByHandle.mockImplementation(async (handles: string[]) => new Map(handles.includes("dylan") ? [["dylan", DYLAN]] : []))
  officers.userNames.mockImplementation(async (ids: (string | null)[]) => new Map(ids.includes("u-dylan") ? [["u-dylan", DYLAN]] : []))
  service.createProspectTx.mockImplementation(async (_tx, fields: { company: string }) => ({ ok: true, prospect: { id: `new-${fields.company}`, company: fields.company }, changed: [] }))
  service.updateProspectTx.mockImplementation(async (_tx, id: string) => ({ ok: true, prospect: { ...apex, id }, changed: ["stage"] }))
})

describe("prospect.upsert", () => {
  it("is offered by propose_meeting to officers, for arrays of prospects", () => {
    expect(prospectUpsertKind).toMatchObject({ kind: "prospect.upsert", tool: "propose_meeting", permission: "officer", targetType: "SPONSOR_PROSPECT" })
    expect(prospectUpsertSchema.safeParse({ prospects: [] }).success).toBe(false)
    expect(prospectUpsertSchema.safeParse({ prospects: [{ website: "acme.com" }] }).success).toBe(false)
    expect(prospectUpsertSchema.safeParse({ prospects: [{ prospectId: "pr-apex" }] }).success).toBe(false)
    expect(prospectUpsertSchema.safeParse({ prospects: [{ prospectId: "pr-apex", stage: "talking" }, { prospectId: "pr-apex", notes: "x" }] }).success).toBe(false)
    expect(prospectUpsertSchema.safeParse({ prospects: [{ company: "Bolt" }, { prospectId: "pr-apex", stage: "talking" }] }).success).toBe(true)
  })

  it("describes new prospects and changes as rows, a company already there as an ambiguous change", async () => {
    const prepared = await prospectUpsertKind.prepare(
      {
        prospects: [
          { company: "Bolt Energy", stage: "talking", tierInterest: "gold", owner: "@Dylan", nextStep: "Send the packet", nextStepDue: "2026-10-30" },
          { prospectId: "pr-apex", stage: "talking", owner: "dylan" },
          { company: "crest wheels", contactName: "Sam Rivera", notes: "Met at the expo" },
        ],
      },
      ctx,
    )
    expect(prepared.view.title).toBe("Add 1 sponsor prospect and update 2")
    expect(prepared.view.rows).toEqual([
      { id: "p1", label: "Bolt Energy", detail: "New · Talking · Gold interest · Dylan · next: Send the packet (Fri Oct 30)" },
      { id: "p2", label: "Apex Sim Rigs", detail: "Stage: Contacted → Talking; Owner: none → Dylan" },
      { id: "p3", label: "Crest Wheels", detail: "Already a prospect: applying changes it. Notes changed", status: "ambiguous" },
    ])
    expect(prepared.view.diff.map((row) => row.label)).toEqual([
      "Bolt Energy: Stage",
      "Bolt Energy: Tier interest",
      "Bolt Energy: Owner",
      "Bolt Energy: Next step",
      "Bolt Energy: Next step due",
      "Apex Sim Rigs: Stage",
      "Apex Sim Rigs: Owner",
      "Crest Wheels: Notes",
    ])
    expect(prepared.view.people).toEqual([{ name: "Dylan", detail: "Owner" }])
    expect(prepared.before).toEqual({
      rows: {
        p1: { action: "create", company: "Bolt Energy" },
        p2: { action: "update", prospectId: "pr-apex", company: "Apex Sim Rigs", fields: { stage: "contacted", ownerId: null } },
        p3: { action: "update", prospectId: "pr-crest", company: "Crest Wheels", fields: { notes: null } },
      },
    })
    // Several prospects: nothing for a newer proposal to supersede by target
    expect(prepared.targetId).toBeUndefined()
  })

  it("shows everything a new prospect gets on the card, its contact email and notes included", async () => {
    const prepared = await prospectUpsertKind.prepare(
      { prospects: [{ company: "Bolt Energy", website: "bolt.example", contactName: "Sam Lee", contactRole: "Partnerships", contactEmail: "Sam@Bolt.example", notes: "Met at the expo.\nWants the Gold packet." }] },
      ctx,
    )
    expect(prepared.view.rows).toEqual([{ id: "p1", label: "Bolt Energy", detail: "New · Idea · no owner · contact Sam Lee (Partnerships), sam@bolt.example · with notes" }])
    expect(prepared.view.diff).toEqual([
      { field: "p1.website", label: "Bolt Energy: Website", before: null, after: "https://bolt.example/", format: "text" },
      { field: "p1.contactName", label: "Bolt Energy: Contact", before: null, after: "Sam Lee", format: "text" },
      { field: "p1.contactRole", label: "Bolt Energy: Contact's role", before: null, after: "Partnerships", format: "text" },
      { field: "p1.contactEmail", label: "Bolt Energy: Contact email", before: null, after: "sam@bolt.example", format: "text" },
      { field: "p1.stage", label: "Bolt Energy: Stage", before: null, after: "Idea", format: "value" },
      { field: "p1.notes", label: "Bolt Energy: Notes", before: null, after: "Met at the expo.\nWants the Gold packet.", format: "markdown" },
    ])
  })

  it("refuses two rows for one prospect, by id or by its company's name", async () => {
    await expect(prospectUpsertKind.prepare({ prospects: [{ prospectId: "pr-apex", stage: "talking" }, { company: "APEX Sim Rigs, Inc.", notes: "Met at the expo" }] }, ctx)).rejects.toThrow(
      "Prospects 1 and 2 are both Apex Sim Rigs; put its changes in one row.",
    )
    await expect(prospectUpsertKind.prepare({ prospects: [{ company: "Bolt" }, { company: "Crest Wheels", stage: "talking" }, { company: "crest wheels", notes: "x" }] }, ctx)).rejects.toThrow(/Prospects 2 and 3 are both Crest Wheels/)
  })

  it("targets the prospect when it changes one", async () => {
    const prepared = await prospectUpsertKind.prepare({ prospects: [{ prospectId: "pr-apex", stage: "talking" }] }, ctx)
    expect(prepared.targetId).toBe("pr-apex")
    expect(prepared.view.title).toBe("Update the sponsor prospect “Apex Sim Rigs”")
    expect(prepared.view.links).toEqual([
      { title: "Sponsors", url: "/admin/sponsors" },
      { title: "Apex Sim Rigs", url: "/admin/sponsors/pr-apex" },
    ])
  })

  it("refuses input the model can fix", async () => {
    await expect(prospectUpsertKind.prepare({ prospects: [{ company: "Bolt", owner: "nobody" }] }, ctx)).rejects.toThrow(/@nobody isn't an officer's handle/)
    await expect(prospectUpsertKind.prepare({ prospects: [{ prospectId: "pr-gone", stage: "talking" }] }, ctx)).rejects.toThrow(/no prospect with id pr-gone/)
    await expect(prospectUpsertKind.prepare({ prospects: [{ prospectId: "pr-apex", stage: "contacted" }] }, ctx)).rejects.toThrow(/nothing would change/)
    await expect(prospectUpsertKind.prepare({ prospects: [{ company: "Bolt", contactEmail: "not an email" }] }, ctx)).rejects.toBeInstanceOf(ProposalInputError)
    await expect(prospectUpsertKind.prepare({ prospects: [{ company: "Bolt" }, { company: "BOLT" }] }, ctx)).rejects.toThrow(/in the list twice/)
    await expect(prospectUpsertKind.prepare({ prospects: [{ company: "Apex Sim Rigs", contactName: "Jordan Lee" }] }, ctx)).rejects.toThrow(/already a prospect with these details/)
  })

  it("applies only the picked rows, all in one transaction, with the applying officer and the proposal on the audit", async () => {
    const p = { prospects: [{ company: "Bolt Energy", owner: "dylan" }, { prospectId: "pr-apex", stage: "talking" as const }, { company: "Delta Pedals" }] }
    const { before } = await prospectUpsertKind.prepare(p, ctx)
    expect(await prospectUpsertKind.checkStale(p, before)).toBeNull()
    const result = await prospectUpsertKind.apply(p, applyCtx(before, ["p1", "p2"]))
    expect(service.createProspectTx).toHaveBeenCalledTimes(1)
    expect(service.createProspectTx.mock.calls[0][1]).toMatchObject({ company: "Bolt Energy", ownerId: "u-dylan" })
    expect(service.createProspectTx.mock.calls[0][2]).toEqual({ userId: "u-gray", auditMetadata: audit })
    expect(service.updateProspectTx.mock.calls[0].slice(1)).toEqual(["pr-apex", { stage: "talking" }, { userId: "u-gray", auditMetadata: audit }, { expected: { stage: "contacted" } }])
    expect(result).toMatchObject({ summary: "Added 1 sponsor prospect and updated 1 prospect.", appliedRows: ["p1", "p2"], created: [{ type: "SPONSOR_PROSPECT", id: "new-Bolt Energy" }] })
  })

  it("goes stale when a picked prospect changed, was deleted, or a new company was added meanwhile", async () => {
    const p = { prospects: [{ prospectId: "pr-apex", stage: "talking" as const }] }
    const { before } = await prospectUpsertKind.prepare(p, ctx)
    service.updateProspectTx.mockResolvedValueOnce({ ok: false, reason: "changed", error: "moved" })
    await expect(prospectUpsertKind.apply(p, applyCtx(before))).rejects.toThrow(new StaleProposalError("Apex Sim Rigs changed since this was proposed."))
    service.updateProspectTx.mockResolvedValueOnce({ ok: false, reason: "not_found", error: "gone" })
    await expect(prospectUpsertKind.apply(p, applyCtx(before))).rejects.toBeInstanceOf(StaleProposalError)

    const add = { prospects: [{ company: "Bolt" }] }
    const prepared = await prospectUpsertKind.prepare(add, ctx)
    service.createProspectTx.mockResolvedValueOnce({ ok: false, reason: "duplicate", error: "Bolt is already a prospect." })
    await expect(prospectUpsertKind.apply(add, applyCtx(prepared.before))).rejects.toThrow("Bolt was added as a prospect since this was proposed.")
  })

  it("goes stale when an owner stopped being an officer", async () => {
    const p = { prospects: [{ company: "Bolt", owner: "dylan" }] }
    const { before } = await prospectUpsertKind.prepare(p, ctx)
    officers.officersByHandle.mockResolvedValue(new Map())
    await expect(prospectUpsertKind.apply(p, applyCtx(before))).rejects.toBeInstanceOf(StaleProposalError)
    expect(service.createProspectTx).not.toHaveBeenCalled()
  })
})
