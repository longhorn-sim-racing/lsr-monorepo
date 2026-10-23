import { beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const service = vi.hoisted(() => ({ createActionItem: vi.fn(), updateActionItem: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/services/meeting.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/meeting.service")>()), ...service }))
vi.mock("next/cache", () => cache)

import { addActionItem, editActionItem, setActionItemStatus } from "./actions"

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  service.createActionItem.mockResolvedValue({ ok: true, item: { id: "ai-1", meetingId: "m-1" }, changed: [] })
  service.updateActionItem.mockResolvedValue({ ok: true, item: { id: "ai-1", meetingId: null }, changed: [] })
})

it("needs an officer for everything", async () => {
  guards.requireOfficer.mockRejectedValue(new Error("no"))
  for (const result of [await addActionItem({ text: "Book the room", ownerId: "", due: "" }), await editActionItem("ai-1", { text: "x" }), await setActionItemStatus("ai-1", "done")]) {
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/signed out/) })
  }
  expect(service.createActionItem).not.toHaveBeenCalled()
  expect(service.updateActionItem).not.toHaveBeenCalled()
})

describe("action items", () => {
  it("adds one, on a meeting when given, refreshing its meeting and the Overview", async () => {
    expect(await addActionItem({ text: "Book the room", ownerId: "officer-2", due: "2026-10-30" }, "m-1")).toEqual({ ok: true })
    expect(service.createActionItem).toHaveBeenCalledWith({ text: "Book the room", ownerId: "officer-2", dueAt: new Date("2026-10-30T05:00:00Z") }, { userId: "officer-1" }, { meetingId: "m-1" })
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/meetings/m-1")
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin")
  })

  it("edits only what's sent: no owner and no due date clear them", async () => {
    await editActionItem("ai-1", { ownerId: "", due: "" })
    expect(service.updateActionItem).toHaveBeenCalledWith("ai-1", { ownerId: null, dueAt: null }, { userId: "officer-1" })
    expect(await editActionItem("ai-1", { due: "2026-02-30" })).toMatchObject({ ok: false })
  })

  it("marks done, dropped or open, and nothing else", async () => {
    expect(await setActionItemStatus("ai-1", "done")).toEqual({ ok: true })
    expect(service.updateActionItem).toHaveBeenCalledWith("ai-1", { status: "done" }, { userId: "officer-1" })
    expect(await setActionItemStatus("ai-1", "archived")).toMatchObject({ ok: false })
    service.updateActionItem.mockResolvedValue({ ok: false, reason: "not_found", error: "That action item doesn't exist anymore." })
    expect(await setActionItemStatus("ai-1", "open")).toEqual({ ok: false, error: "That action item doesn't exist anymore." })
  })
})
