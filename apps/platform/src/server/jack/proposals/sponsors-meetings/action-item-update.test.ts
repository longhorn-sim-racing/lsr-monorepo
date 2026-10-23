import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ $transaction: vi.fn(), actionItem: { findMany: vi.fn() }, meeting: { findMany: vi.fn() } }))
const officers = vi.hoisted(() => ({ officersByHandle: vi.fn(), userNames: vi.fn() }))
const service = vi.hoisted(() => ({ createActionItemTx: vi.fn(), updateActionItemTx: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/officers", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/officers")>()), ...officers }))
vi.mock("@/server/services/meeting.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/meeting.service")>()), ...service }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { actionItemUpdateKind, actionItemUpdateSchema } from "./action-item-update"

const ctx: ProposalContext = { roomId: "room-1", officer: { userId: "u-ana", displayName: "Ana" } }
const audit = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u-ana" }
const applyCtx = (before: unknown, selectedRows?: string[]): ProposalApplyContext => ({ officer: { userId: "u-gray", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: audit, selectedRows })

const DYLAN = { id: "u-dylan", displayName: "Dylan", handle: "dylan" }
const ALEX = { id: "u-alex", displayName: "Alex", handle: "alex" }
const packet = { id: "ai-1", text: "Send the sponsor packet to Apex", ownerId: "u-dylan", dueAt: new Date("2026-10-20T05:00:00Z"), status: "open", doneAt: null, meetingId: "m-1", roomId: null, createdById: null, createdAt: new Date(), updatedAt: new Date() }
const lounge = { ...packet, id: "ai-2", text: "Book the lounge", ownerId: null, dueAt: null, meetingId: null }

beforeEach(() => {
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db))
  db.actionItem.findMany.mockResolvedValue([packet, lounge])
  db.meeting.findMany.mockResolvedValue([{ id: "m-1", title: "Board meeting" }])
  officers.officersByHandle.mockImplementation(async (handles: string[]) => new Map([DYLAN, ALEX].filter((o) => handles.includes(o.handle)).map((o) => [o.handle, o])))
  officers.userNames.mockResolvedValue(new Map([DYLAN, ALEX].map((o) => [o.id, o])))
  service.updateActionItemTx.mockImplementation(async (_tx, id: string, changes: { status?: string }) => ({ ok: true, item: { ...packet, id, ...changes }, changed: Object.keys(changes) }))
  service.createActionItemTx.mockImplementation(async (_tx, fields: object) => ({ ok: true, item: { ...lounge, id: "ai-new", ...fields }, changed: [] }))
})

describe("action_item.update", () => {
  it("is offered by propose_change to officers; ids from meetings_list, or new items with text", () => {
    expect(actionItemUpdateKind).toMatchObject({ kind: "action_item.update", tool: "propose_change", permission: "officer", targetType: "ACTION_ITEM" })
    expect(actionItemUpdateSchema.safeParse({ items: [{ id: "ai-1" }] }).success).toBe(false)
    expect(actionItemUpdateSchema.safeParse({ items: [{ owner: "dylan" }] }).success).toBe(false)
    expect(actionItemUpdateSchema.safeParse({ items: [{ id: "ai-1", meetingId: "m-1", status: "done" }] }).success).toBe(false)
    expect(actionItemUpdateSchema.safeParse({ items: [{ id: "ai-1", status: "done" }, { text: "Order banners", owner: "alex", due: "2026-11-02" }] }).success).toBe(true)
  })

  it("names a single change plainly and targets the item", async () => {
    const prepared = await actionItemUpdateKind.prepare({ items: [{ id: "ai-1", status: "done" }] }, ctx)
    expect(prepared.view.title).toBe("Mark “Send the sponsor packet to Apex” done")
    expect(prepared.targetId).toBe("ai-1")
    expect(prepared.view.rows).toEqual([{ id: "i1", label: "Send the sponsor packet to Apex", detail: "Status: Open → Done" }])
    expect(prepared.view.links).toEqual([
      { title: "Action items", url: "/admin/action-items" },
      { title: "Its meeting", url: "/admin/meetings/m-1" },
    ])
    expect((await actionItemUpdateKind.prepare({ items: [{ id: "ai-1", owner: "alex" }] }, ctx)).view.title).toBe("Reassign “Send the sponsor packet to Apex”")
  })

  it("puts several changes and new items on rows", async () => {
    const prepared = await actionItemUpdateKind.prepare(
      {
        items: [
          { id: "ai-1", owner: "alex", due: "2026-10-27" },
          { id: "ai-2", status: "dropped" },
          { text: "Order banners", owner: "dylan", due: "2026-11-02", meetingId: "m-1" },
        ],
      },
      ctx,
    )
    expect(prepared.view.title).toBe("Add 1 action item and update 2")
    expect(prepared.view.rows).toEqual([
      { id: "i1", label: "Send the sponsor packet to Apex", detail: "Owner: Dylan → Alex; Due: Tue Oct 20 → Tue Oct 27" },
      { id: "i2", label: "Book the lounge", detail: "Status: Open → Dropped" },
      { id: "i3", label: "Order banners", detail: "New · Dylan · due Mon Nov 2 · from Board meeting" },
    ])
    expect(prepared.before).toEqual({
      rows: {
        i1: { action: "update", itemId: "ai-1", text: "Send the sponsor packet to Apex", fields: { ownerId: "u-dylan", dueAt: "2026-10-20T05:00:00.000Z" } },
        i2: { action: "update", itemId: "ai-2", text: "Book the lounge", fields: { status: "open" } },
        i3: { action: "create" },
      },
    })
  })

  it("refuses unknown items and meetings, changes that change nothing, and a new item that isn't open", async () => {
    await expect(actionItemUpdateKind.prepare({ items: [{ id: "ai-9", status: "done" }] }, ctx)).rejects.toThrow(/no action item with id ai-9/)
    await expect(actionItemUpdateKind.prepare({ items: [{ text: "Order banners", meetingId: "m-9" }] }, ctx)).rejects.toThrow(/no meeting with id m-9/)
    await expect(actionItemUpdateKind.prepare({ items: [{ id: "ai-1", status: "open" }] }, ctx)).rejects.toThrow(/nothing would change/)
    await expect(actionItemUpdateKind.prepare({ items: [{ text: "Order banners", status: "done" }] }, ctx)).rejects.toThrow(/starts open/)
    await expect(actionItemUpdateKind.prepare({ items: [{ id: "ai-1", owner: "ghost" }] }, ctx)).rejects.toThrow(/@ghost isn't an officer's handle/)
  })

  it("applies the picked rows, only the fields that differed, checked against what was read", async () => {
    const p = { items: [{ id: "ai-1", owner: "alex" }, { id: "ai-2", status: "done" as const }, { text: "Order banners" }] }
    const { before } = await actionItemUpdateKind.prepare(p, ctx)
    const result = await actionItemUpdateKind.apply(p, applyCtx(before, ["i2", "i3"]))
    expect(service.updateActionItemTx).toHaveBeenCalledTimes(1)
    expect(service.updateActionItemTx.mock.calls[0].slice(1)).toEqual(["ai-2", { status: "done" }, { userId: "u-gray", auditMetadata: audit }, { expected: { status: "open" } }])
    expect(service.createActionItemTx.mock.calls[0].slice(1)).toEqual([{ text: "Order banners", ownerId: null, dueAt: null }, { userId: "u-gray", auditMetadata: audit }, { meetingId: null, roomId: "room-1" }])
    expect(result).toMatchObject({ summary: "Added 1 action item and updated 1 action item (1 marked done).", appliedRows: ["i2", "i3"], created: [{ type: "ACTION_ITEM", id: "ai-new" }] })
  })

  it("goes stale when a picked item changed or was deleted", async () => {
    const p = { items: [{ id: "ai-1", status: "done" as const }] }
    const { before } = await actionItemUpdateKind.prepare(p, ctx)
    service.updateActionItemTx.mockResolvedValueOnce({ ok: false, reason: "changed", error: "moved" })
    await expect(actionItemUpdateKind.apply(p, applyCtx(before))).rejects.toThrow(new StaleProposalError("“Send the sponsor packet to Apex” changed since this was proposed."))
    service.updateActionItemTx.mockResolvedValueOnce({ ok: false, reason: "not_found", error: "gone" })
    await expect(actionItemUpdateKind.apply(p, applyCtx(before))).rejects.toBeInstanceOf(StaleProposalError)
  })
})
