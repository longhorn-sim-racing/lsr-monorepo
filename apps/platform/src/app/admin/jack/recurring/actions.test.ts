import { beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const session = vi.hoisted(() => ({ getCachedSessionUser: vi.fn() }))
const service = vi.hoisted(() => ({
  createRecurringQuestion: vi.fn(),
  updateRecurringQuestion: vi.fn(),
  setRecurringQuestionOn: vi.fn(),
  deleteRecurringQuestion: vi.fn(),
  askRecurringQuestionNow: vi.fn(),
}))
const settings = vi.hoisted(() => ({ saveDigestSettings: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/auth/cached-session", () => session)
vi.mock("@/server/automation/recurring/service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/automation/recurring/service")>()), ...service }))
vi.mock("@/server/automation/digest/settings", () => settings)
vi.mock("next/cache", () => cache)
vi.mock("@/server/db", () => ({ prisma: {} }))

import {
  askRecurringQuestionNowAction,
  createRecurringQuestionAction,
  deleteRecurringQuestionAction,
  saveDigestSettingsAction,
  setRecurringQuestionOnAction,
  updateRecurringQuestionAction,
  type RecurringFormInput,
} from "./actions"

const form = (overrides: Partial<RecurringFormInput> = {}): RecurringFormInput => ({
  title: "Weekly signups",
  prompt: "How many signed up?",
  roomId: "room-1",
  persona: "jack",
  every: "week",
  days: ["mon", "thu"],
  dayOfMonth: "1",
  time: "09:00",
  ...overrides,
})
const digest = { enabled: true, roomId: "room-1", day: "mon" as const, time: "09:00", summary: true, discordChannelId: "", teams: false }

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  session.getCachedSessionUser.mockResolvedValue({ user: { id: "officer-1" }, roles: ["officer"] })
  service.createRecurringQuestion.mockResolvedValue({ ok: true, question: { id: "q-1" }, changed: [] })
  service.updateRecurringQuestion.mockResolvedValue({ ok: true, question: { id: "q-1" }, changed: [] })
  service.setRecurringQuestionOn.mockResolvedValue({ ok: true, question: { id: "q-1" }, changed: ["enabled", "createdById"] })
  service.deleteRecurringQuestion.mockResolvedValue({ ok: true, title: "Weekly signups" })
  service.askRecurringQuestionNow.mockResolvedValue({ ok: true, title: "Weekly signups" })
  settings.saveDigestSettings.mockResolvedValue({ ok: true, changed: [] })
})

it("needs an officer for everything", async () => {
  guards.requireOfficer.mockRejectedValue(new Error("no"))
  const results = [
    await createRecurringQuestionAction(form()),
    await updateRecurringQuestionAction("q-1", form()),
    await setRecurringQuestionOnAction("q-1", true),
    await deleteRecurringQuestionAction("q-1"),
    await askRecurringQuestionNowAction("q-1"),
    await saveDigestSettingsAction(digest),
  ]
  for (const result of results) expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/signed out/) })
  for (const fn of [...Object.values(service), settings.saveDigestSettings]) expect(fn).not.toHaveBeenCalled()
})

describe("recurring questions", () => {
  it("sets one up from the form, its schedule as the shape picked, off unless asked", async () => {
    expect(await createRecurringQuestionAction(form())).toEqual({ ok: true, data: { id: "q-1" } })
    expect(service.createRecurringQuestion).toHaveBeenCalledWith(
      { title: "Weekly signups", prompt: "How many signed up?", roomId: "room-1", persona: "jack", schedule: { every: "week", time: "09:00", days: ["mon", "thu"] } },
      { userId: "officer-1" },
      { enabled: false },
    )
    await createRecurringQuestionAction(form({ every: "month", dayOfMonth: "15", on: true }))
    expect(service.createRecurringQuestion.mock.calls[1][0].schedule).toEqual({ every: "month", time: "09:00", dayOfMonth: 15 })
    expect(service.createRecurringQuestion.mock.calls[1][2]).toEqual({ enabled: true })
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/jack/recurring")
  })

  it("changes one as the officer saving it, and says when that made it theirs", async () => {
    expect(await updateRecurringQuestionAction("q-1", form())).toEqual({ ok: true, data: { tookOver: false } })
    expect(service.updateRecurringQuestion).toHaveBeenCalledWith("q-1", expect.objectContaining({ prompt: "How many signed up?" }), { userId: "officer-1" })
    service.updateRecurringQuestion.mockResolvedValue({ ok: true, question: { id: "q-1" }, changed: ["prompt", "createdById"] })
    expect(await updateRecurringQuestionAction("q-1", form())).toEqual({ ok: true, data: { tookOver: true } })
  })

  it("passes the service's refusals back to the form", async () => {
    service.updateRecurringQuestion.mockResolvedValue({ ok: false, reason: "room", error: "That room is archived." })
    expect(await updateRecurringQuestionAction("q-1", form())).toEqual({ ok: false, error: "That room is archived." })
  })

  it("says when turning one on took it over", async () => {
    expect(await setRecurringQuestionOnAction("q-1", true)).toEqual({ ok: true, data: { tookOver: true } })
    expect(service.setRecurringQuestionOn).toHaveBeenCalledWith("q-1", true, { userId: "officer-1" })
    expect(await setRecurringQuestionOnAction("", true)).toMatchObject({ ok: false })
  })
})

describe("the digest's settings", () => {
  it("passes whether the officer is an admin, so only admins change Discord and Teams", async () => {
    await saveDigestSettingsAction(digest)
    expect(settings.saveDigestSettings).toHaveBeenCalledWith(digest, { userId: "officer-1", isAdmin: false })
    session.getCachedSessionUser.mockResolvedValue({ user: { id: "officer-1" }, roles: ["officer", "admin"] })
    await saveDigestSettingsAction(digest)
    expect(settings.saveDigestSettings).toHaveBeenLastCalledWith(digest, { userId: "officer-1", isAdmin: true })
  })
})
