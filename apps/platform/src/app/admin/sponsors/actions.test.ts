import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const service = vi.hoisted(() => ({ createProspect: vi.fn(), updateProspect: vi.fn(), logProspectActivity: vi.fn(), deleteProspectActivity: vi.fn(), deleteProspect: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/services/sponsor.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/sponsor.service")>()), ...service }))
vi.mock("next/cache", () => cache)

import { logActivity, removeActivity, removeProspect, saveProspect } from "./actions"

const NOW = new Date("2026-10-22T17:00:00Z") // Thu Oct 22, noon Central

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  service.createProspect.mockResolvedValue({ ok: true, prospect: { id: "pr-new" }, changed: [] })
  service.updateProspect.mockResolvedValue({ ok: true, prospect: { id: "pr-1" }, changed: [] })
  service.logProspectActivity.mockResolvedValue({ ok: true })
  service.deleteProspectActivity.mockResolvedValue({ ok: true, prospectId: "pr-1" })
  service.deleteProspect.mockResolvedValue({ ok: true, company: "Apex" })
})

afterEach(() => {
  vi.useRealTimers()
})

it("needs an officer for everything", async () => {
  guards.requireOfficer.mockRejectedValue(new Error("Requires one of the following roles: admin, officer"))
  for (const result of [await saveProspect(null, { company: "Apex" }), await logActivity("pr-1", { type: "call", summary: "x", date: "2026-10-22", stage: "" }), await removeActivity("a-1"), await removeProspect("pr-1")]) {
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/signed out or no longer an officer/) })
  }
  expect(Object.values(service).every((fn) => fn.mock.calls.length === 0)).toBe(true)
})

describe("saveProspect", () => {
  it("adds a prospect as the officer, the due date as the start of its Central day", async () => {
    expect(await saveProspect(null, { company: "Apex", stage: "talking", nextStepDue: "2026-10-30", ownerId: "" })).toEqual({ ok: true, id: "pr-new" })
    expect(service.createProspect).toHaveBeenCalledWith({ company: "Apex", stage: "talking", nextStepDue: new Date("2026-10-30T05:00:00Z"), ownerId: "" }, { userId: "officer-1" })
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/sponsors/pr-new")
  })

  it("edits only the fields sent, and passes back a duplicate to open", async () => {
    await saveProspect("pr-1", { nextStepDue: "" })
    expect(service.updateProspect).toHaveBeenCalledWith("pr-1", { nextStepDue: null }, { userId: "officer-1" })
    service.createProspect.mockResolvedValue({ ok: false, reason: "duplicate", error: "Apex is already a prospect.", duplicateId: "pr-1" })
    expect(await saveProspect(null, { company: "Apex" })).toEqual({ ok: false, error: "Apex is already a prospect. Open it instead of adding it again.", duplicateId: "pr-1" })
  })

  it("refuses a date that isn't on the calendar and an unknown stage", async () => {
    expect(await saveProspect(null, { company: "Apex", nextStepDue: "2026-02-30" })).toMatchObject({ ok: false })
    expect(await saveProspect(null, { company: "Apex", stage: "warm" })).toMatchObject({ ok: false })
    expect(service.createProspect).not.toHaveBeenCalled()
  })
})

describe("logActivity", () => {
  it("logs today's activity now, and an earlier day's at noon that day", async () => {
    await logActivity("pr-1", { type: "call", summary: "Talked budgets", date: "2026-10-22", stage: "talking" })
    expect(service.logProspectActivity).toHaveBeenLastCalledWith("pr-1", { type: "call", summary: "Talked budgets", occurredAt: NOW }, { userId: "officer-1" }, { stage: "talking" })
    await logActivity("pr-1", { type: "meeting", summary: "Intro", date: "2026-10-20", stage: "" })
    expect(service.logProspectActivity).toHaveBeenLastCalledWith("pr-1", { type: "meeting", summary: "Intro", occurredAt: new Date("2026-10-20T17:00:00Z") }, { userId: "officer-1" }, {})
  })

  it("refuses a future date, a stage change type, and a missing date", async () => {
    expect(await logActivity("pr-1", { type: "call", summary: "x", date: "2026-10-23", stage: "" })).toMatchObject({ ok: false, error: expect.stringMatching(/future/) })
    expect(await logActivity("pr-1", { type: "stage_change", summary: "x", date: "2026-10-22", stage: "" })).toMatchObject({ ok: false })
    expect(await logActivity("pr-1", { type: "call", summary: "x", date: "", stage: "" })).toMatchObject({ ok: false })
    expect(service.logProspectActivity).not.toHaveBeenCalled()
  })
})
