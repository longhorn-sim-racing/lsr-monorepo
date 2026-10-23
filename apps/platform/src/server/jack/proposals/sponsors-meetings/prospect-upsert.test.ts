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

beforeEach(() => {
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db))
  db.sponsorProspect.findMany.mockResolvedValue([apex])
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
          { company: "apex sim rigs", contactName: "Jordan Lee", notes: "Met at the expo" },
        ],
      },
      ctx,
    )
    expect(prepared.view.title).toBe("Add 1 sponsor prospect and update 2")
    expect(prepared.view.rows).toEqual([
      { id: "p1", label: "Bolt Energy", detail: "New · Talking · Gold interest · Dylan · next: Send the packet (Fri Oct 30)" },
      { id: "p2", label: "Apex Sim Rigs", detail: "Stage: Contacted → Talking; Owner: none → Dylan" },
      { id: "p3", label: "Apex Sim Rigs", detail: "Already a prospect: applying changes it. Notes changed", status: "ambiguous" },
    ])
    expect(prepared.view.diff.map((row) => row.label)).toEqual(["Apex Sim Rigs: Stage", "Apex Sim Rigs: Owner", "Apex Sim Rigs: Notes"])
    expect(prepared.view.people).toEqual([{ name: "Dylan", detail: "Owner" }])
    expect(prepared.before).toEqual({
      rows: {
        p1: { action: "create", company: "Bolt Energy" },
        p2: { action: "update", prospectId: "pr-apex", company: "Apex Sim Rigs", fields: { stage: "contacted", ownerId: null } },
        p3: { action: "update", prospectId: "pr-apex", company: "Apex Sim Rigs", fields: { notes: null } },
      },
    })
    // Several prospects: nothing for a newer proposal to supersede by target
    expect(prepared.targetId).toBeUndefined()
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
    const p = { prospects: [{ company: "Bolt Energy", owner: "dylan" }, { prospectId: "pr-apex", stage: "talking" as const }, { company: "Crest Wheels" }] }
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
