import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ $transaction: vi.fn(), sponsorProspect: { findMany: vi.fn() }, sponsorActivity: { findMany: vi.fn() } }))
const service = vi.hoisted(() => ({ logProspectActivityTx: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/sponsor.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/sponsor.service")>()), ...service }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { prospectActivityKind } from "./prospect-activity"

const NOW = new Date("2026-10-22T17:00:00Z") // Thu Oct 22, noon Central
const ctx: ProposalContext = { roomId: "room-1", officer: { userId: "u-ana", displayName: "Ana" } }
const audit = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u-ana" }
const applyCtx = (before: unknown, selectedRows?: string[]): ProposalApplyContext => ({ officer: { userId: "u-gray", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: audit, selectedRows })

const prospect = (id: string, company: string, overrides: Record<string, unknown> = {}) => ({ id, company, stage: "contacted", nextStep: null, nextStepDue: null, ...overrides })

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db))
  db.sponsorProspect.findMany.mockResolvedValue([prospect("pr-apex", "Apex Sim Rigs"), prospect("pr-bolt", "Bolt Energy", { stage: "talking" })])
  db.sponsorActivity.findMany.mockResolvedValue([])
  service.logProspectActivityTx.mockImplementation(async () => ({ ok: true, activity: {}, prospect: {}, changed: [] }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("prospect.activity", () => {
  it("is offered by propose_meeting to officers", () => {
    expect(prospectActivityKind).toMatchObject({ kind: "prospect.activity", tool: "propose_meeting", permission: "officer" })
  })

  it("puts each activity on a row, with any stage or next-step change, fixing when it happened", async () => {
    const prepared = await prospectActivityKind.prepare(
      {
        activities: [
          { prospectId: "pr-apex", type: "meeting", summary: "Intro call with Jordan; they want a deck", date: "2026-10-20", stage: "talking", nextStep: "Send the deck", nextStepDue: "2026-10-27" },
          { prospectId: "pr-bolt", type: "email_sent", summary: "Sent the packet" },
        ],
      },
      ctx,
    )
    expect(prepared.view.title).toBe("Log 2 sponsor activities")
    expect(prepared.view.rows).toEqual([
      { id: "a1", label: "Apex Sim Rigs: Meeting, Tue Oct 20", detail: "Intro call with Jordan; they want a deck · Stage: Contacted → Talking · Next step: none → Send the deck · Next step due: none → Tue Oct 27" },
      { id: "a2", label: "Bolt Energy: Email sent, Thu Oct 22", detail: "Sent the packet" },
    ])
    expect(prepared.view.diff.map((row) => [row.label, row.before, row.after])).toEqual([
      ["Apex Sim Rigs: Stage", "Contacted", "Talking"],
      ["Apex Sim Rigs: Next step", null, "Send the deck"],
      ["Apex Sim Rigs: Next step due", null, "Tue Oct 27"],
    ])
    expect(prepared.before).toEqual({
      rows: {
        // An earlier day: noon Central that day. Today: the moment it was proposed
        a1: { prospectId: "pr-apex", company: "Apex Sim Rigs", occurredAt: "2026-10-20T17:00:00.000Z", fields: { stage: "contacted", nextStep: null, nextStepDue: null } },
        a2: { prospectId: "pr-bolt", company: "Bolt Energy", occurredAt: NOW.toISOString(), fields: {} },
      },
    })
  })

  it("marks one that looks already logged as ambiguous", async () => {
    db.sponsorActivity.findMany.mockResolvedValue([{ prospectId: "pr-apex", type: "email_sent", summary: "Sent the packet", occurredAt: new Date("2026-10-22T14:00:00Z") }])
    const prepared = await prospectActivityKind.prepare({ activities: [{ prospectId: "pr-apex", type: "email_sent", summary: "sent the packet " }] }, ctx)
    expect(prepared.view.rows?.[0]).toMatchObject({ status: "ambiguous", detail: expect.stringMatching(/^Looks already logged/) })
    expect(prepared.view.title).toBe("Log an email to Apex Sim Rigs")
  })

  it("refuses unknown prospects, future dates, and two rows moving one prospect", async () => {
    await expect(prospectActivityKind.prepare({ activities: [{ prospectId: "pr-gone", type: "note", summary: "x" }] }, ctx)).rejects.toThrow(/no prospect with id pr-gone/)
    await expect(prospectActivityKind.prepare({ activities: [{ prospectId: "pr-apex", type: "meeting", summary: "x", date: "2026-10-23" }] }, ctx)).rejects.toThrow(/after today/)
    await expect(
      prospectActivityKind.prepare(
        {
          activities: [
            { prospectId: "pr-apex", type: "call", summary: "x", stage: "talking" },
            { prospectId: "pr-apex", type: "note", summary: "y", nextStep: "z" },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/one of its entries only/)
  })

  it("logs the picked rows as the officer who reported them, checking the fields it changes", async () => {
    const p = {
      activities: [
        { prospectId: "pr-apex", type: "meeting" as const, summary: "Intro call", date: "2026-10-20", stage: "talking" as const },
        { prospectId: "pr-bolt", type: "email_sent" as const, summary: "Sent the packet" },
      ],
    }
    const { before } = await prospectActivityKind.prepare(p, ctx)
    vi.setSystemTime(new Date("2026-10-23T17:00:00Z"))
    const result = await prospectActivityKind.apply(p, applyCtx(before, ["a1"]))
    expect(service.logProspectActivityTx).toHaveBeenCalledTimes(1)
    const [, id, activity, actor, options] = service.logProspectActivityTx.mock.calls[0]
    expect(id).toBe("pr-apex")
    expect(activity).toEqual({ type: "meeting", summary: "Intro call", occurredAt: new Date("2026-10-20T17:00:00Z") })
    expect(actor).toEqual({ userId: "u-gray", auditMetadata: audit })
    expect(options).toEqual({ byId: "u-ana", stage: "talking", expected: { stage: "contacted" } })
    expect(result).toMatchObject({ summary: "Logged 1 activity for Apex Sim Rigs.", appliedRows: ["a1"] })
  })

  it("keeps the time it was proposed for today's entries, not the time it's applied", async () => {
    const p = { activities: [{ prospectId: "pr-bolt", type: "call" as const, summary: "Quick call" }] }
    const { before } = await prospectActivityKind.prepare(p, ctx)
    vi.setSystemTime(new Date("2026-10-24T17:00:00Z"))
    await prospectActivityKind.apply(p, applyCtx(before))
    expect(service.logProspectActivityTx.mock.calls[0][2].occurredAt).toEqual(NOW)
  })

  it("goes stale when the stage it moves changed meanwhile", async () => {
    const p = { activities: [{ prospectId: "pr-apex", type: "call" as const, summary: "x", stage: "talking" as const }] }
    const { before } = await prospectActivityKind.prepare(p, ctx)
    service.logProspectActivityTx.mockResolvedValueOnce({ ok: false, reason: "changed", error: "moved" })
    await expect(prospectActivityKind.apply(p, applyCtx(before))).rejects.toThrow(new StaleProposalError("Apex Sim Rigs's stage or next step changed since this was proposed."))
  })
})
