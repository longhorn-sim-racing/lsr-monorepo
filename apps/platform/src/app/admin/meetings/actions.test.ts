import { beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const service = vi.hoisted(() => ({ createMeeting: vi.fn(), updateMeeting: vi.fn(), deleteMeeting: vi.fn(), addDecision: vi.fn(), removeDecision: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/services/meeting.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/meeting.service")>()), ...service }))
vi.mock("next/cache", () => cache)

import { addMeetingDecision, removeMeeting, removeMeetingDecision, saveMeeting } from "./actions"

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  service.createMeeting.mockResolvedValue({ ok: true, meeting: { id: "m-new" }, changed: [] })
  service.updateMeeting.mockResolvedValue({ ok: true, meeting: { id: "m-1" }, changed: [] })
  service.deleteMeeting.mockResolvedValue({ ok: true, title: "Board" })
  service.addDecision.mockResolvedValue({ ok: true, decision: {}, knowledge: { ok: true, entryId: "k-1" } })
  service.removeDecision.mockResolvedValue({ ok: true, meetingId: "m-1" })
})

it("needs an officer for everything", async () => {
  guards.requireOfficer.mockRejectedValue(new Error("no"))
  for (const result of [await saveMeeting(null, { title: "Board" }), await removeMeeting("m-1"), await addMeetingDecision("m-1", { text: "Yes", title: "" }), await removeMeetingDecision("d-1")]) {
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/signed out/) })
  }
  expect(Object.values(service).every((fn) => fn.mock.calls.length === 0)).toBe(true)
})

describe("saveMeeting", () => {
  it("records a meeting, its date and time as one Central instant", async () => {
    expect(await saveMeeting(null, { title: "Board meeting", type: "board", date: "2026-10-19", time: "18:30", agendaMd: "1. Sponsors", summaryMd: "" })).toEqual({ ok: true, id: "m-new" })
    expect(service.createMeeting).toHaveBeenCalledWith({ title: "Board meeting", type: "board", heldAt: new Date("2026-10-19T23:30:00Z"), agendaMd: "1. Sponsors", summaryMd: "" }, { userId: "officer-1" })
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/meetings/m-new/agenda")
  })

  it("edits only what's sent; a date without a time is the start of the day", async () => {
    await saveMeeting("m-1", { date: "2026-10-20", time: "" })
    expect(service.updateMeeting).toHaveBeenCalledWith("m-1", { heldAt: new Date("2026-10-20T05:00:00Z") }, { userId: "officer-1" })
    await saveMeeting("m-1", { summaryMd: "Done" })
    expect(service.updateMeeting).toHaveBeenLastCalledWith("m-1", { summaryMd: "Done" }, { userId: "officer-1" })
  })

  it("refuses a bad type, date or time", async () => {
    expect(await saveMeeting(null, { title: "Board", type: "party", date: "2026-10-19", time: "" })).toMatchObject({ ok: false })
    expect(await saveMeeting(null, { title: "Board", type: "board", date: "2026-13-01", time: "" })).toMatchObject({ ok: false })
    expect(await saveMeeting(null, { title: "Board", type: "board", date: "2026-10-19", time: "6pm" })).toMatchObject({ ok: false })
    expect(service.createMeeting).not.toHaveBeenCalled()
  })
})

describe("decisions", () => {
  it("adds one and says whether it reached the decision log", async () => {
    expect(await addMeetingDecision("m-1", { text: "Keep the tiers.", title: "" })).toEqual({ ok: true, data: { logged: true } })
    expect(service.addDecision).toHaveBeenCalledWith("m-1", { text: "Keep the tiers.", title: "" }, { userId: "officer-1" })
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/knowledge")
    service.addDecision.mockResolvedValue({ ok: true, decision: {}, knowledge: { ok: false, error: "It looks like it holds a key." } })
    expect(await addMeetingDecision("m-1", { text: "x", title: "" })).toEqual({ ok: true, data: { logged: false, note: "It looks like it holds a key." } })
  })
})
