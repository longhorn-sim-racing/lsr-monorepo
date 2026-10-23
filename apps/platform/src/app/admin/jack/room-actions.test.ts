import { beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const settings = vi.hoisted(() => ({
  ROOM_GONE: "That room doesn't exist anymore.",
  answerModeLabel: vi.fn((mode: string) => (mode === "mention" ? "answer only messages that mention @Jack" : "answer every message")),
  setRoomArchived: vi.fn(),
  setRoomPinned: vi.fn(),
  setRoomAnswerMode: vi.fn(),
  unavailableMessage: vi.fn(),
}))
const feedback = vi.hoisted(() => ({ setReplyFeedback: vi.fn() }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/jack/room-settings", () => settings)
vi.mock("@/server/jack/feedback", () => feedback)
vi.mock("@/server/audit/log", () => audit)
vi.mock("next/cache", () => cache)

import { archiveJackRoom, pinJackRoom, rateJackReply, setJackRoomAnswerMode } from "./room-actions"

const ROOM = "11111111-1111-4111-8111-111111111111"
const REPLY = "22222222-2222-4222-8222-222222222222"
const officer = { id: "officer-1", displayName: "Gray" }
const view = (fields: Record<string, unknown> = {}) => ({ id: ROOM, title: "GM 2", persona: "jack", updatedAt: "2026-10-22T00:00:00.000Z", pinnedAt: null, answerMode: "always", archivedAt: null, ...fields })
const note = { id: "n1", roomId: ROOM, content: "Gray archived this room" }

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue(officer)
  settings.unavailableMessage.mockResolvedValue("This room is archived. Unarchive it to continue.")
  settings.answerModeLabel.mockImplementation((mode: string) => (mode === "mention" ? "answer only messages that mention @Jack" : "answer every message"))
})

describe("officers only", () => {
  it("refuses anyone else before touching a room", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("NotAuthorized"))
    await expect(archiveJackRoom(ROOM, true)).rejects.toThrow()
    await expect(pinJackRoom(ROOM, true)).rejects.toThrow()
    await expect(setJackRoomAnswerMode(ROOM, "mention")).rejects.toThrow()
    await expect(rateJackReply(REPLY, "up")).rejects.toThrow()
    expect(settings.setRoomArchived).not.toHaveBeenCalled()
    expect(settings.setRoomPinned).not.toHaveBeenCalled()
    expect(settings.setRoomAnswerMode).not.toHaveBeenCalled()
    expect(feedback.setReplyFeedback).not.toHaveBeenCalled()
  })
})

describe("archiveJackRoom", () => {
  it("archives as the officer, audits it and refreshes the rooms list", async () => {
    const room = view({ archivedAt: "2026-10-22T01:00:00.000Z" })
    settings.setRoomArchived.mockResolvedValue({ changed: true, room, message: note })
    expect(await archiveJackRoom(ROOM, true)).toEqual({ ok: true, data: { room, message: note } })
    expect(settings.setRoomArchived).toHaveBeenCalledWith(ROOM, officer, true)
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "officer-1", actionType: "UPDATE", entityType: "JACK_ROOM", entityId: ROOM, summary: "Archived Jack room: GM 2", after: { archived: true } }))
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/jack")
  })

  it("doesn't audit a change that didn't happen, and says when the room is gone", async () => {
    settings.setRoomArchived.mockResolvedValueOnce({ changed: false, room: view() })
    expect(await archiveJackRoom(ROOM, false)).toEqual({ ok: true, data: { room: view(), message: null } })
    expect(audit.createAuditLog).not.toHaveBeenCalled()
    settings.setRoomArchived.mockResolvedValueOnce(null)
    expect(await archiveJackRoom(ROOM, false)).toEqual({ ok: false, error: "That room doesn't exist anymore." })
    expect(await archiveJackRoom("not-a-room", true)).toEqual({ ok: false, error: "That room doesn't exist anymore." })
    expect(settings.setRoomArchived).toHaveBeenCalledTimes(2)
  })
})

describe("pinJackRoom", () => {
  it("pins, audits it, and refreshes the list", async () => {
    settings.setRoomPinned.mockResolvedValue({ changed: true, room: view({ pinnedAt: "2026-10-22T01:00:00.000Z" }), message: null })
    expect(await pinJackRoom(ROOM, true)).toMatchObject({ ok: true, data: { room: { pinnedAt: "2026-10-22T01:00:00.000Z" } } })
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ summary: "Pinned Jack room: GM 2", after: { pinned: true } }))
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/jack")
  })

  it("says the room is archived when it can't be pinned", async () => {
    settings.setRoomPinned.mockResolvedValue(null)
    expect(await pinJackRoom(ROOM, true)).toEqual({ ok: false, error: "This room is archived. Unarchive it to continue." })
    expect(settings.unavailableMessage).toHaveBeenCalledWith(ROOM)
  })
})

describe("setJackRoomAnswerMode", () => {
  it("switches the mode as the officer and audits it", async () => {
    const message = { id: "n2", content: "Gray set this room to answer only messages that mention @Jack" }
    settings.setRoomAnswerMode.mockResolvedValue({ changed: true, room: view({ answerMode: "mention" }), message })
    expect(await setJackRoomAnswerMode(ROOM, "mention")).toEqual({ ok: true, data: { room: view({ answerMode: "mention" }), message } })
    expect(settings.setRoomAnswerMode).toHaveBeenCalledWith(ROOM, officer, "mention")
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ summary: "Set Jack room to answer only messages that mention @Jack", before: { answerMode: "always" }, after: { answerMode: "mention" } }))
  })

  it("refuses a mode that isn't one, and says when the room is archived", async () => {
    expect(await setJackRoomAnswerMode(ROOM, "never")).toEqual({ ok: false, error: "Pick every message or mentions only" })
    settings.setRoomAnswerMode.mockResolvedValue(null)
    expect(await setJackRoomAnswerMode(ROOM, "always")).toEqual({ ok: false, error: "This room is archived. Unarchive it to continue." })
  })
})

describe("rateJackReply", () => {
  const summary = { up: 0, down: 1, mine: { rating: "down", note: "Wrong date" }, raters: [] }

  it("rates as the signed-in officer, trimming the note and dropping an empty one", async () => {
    feedback.setReplyFeedback.mockResolvedValue({ ok: true, roomId: ROOM, summary })
    expect(await rateJackReply(REPLY, "down", "  Wrong date  ")).toEqual({ ok: true, data: { summary } })
    expect(feedback.setReplyFeedback).toHaveBeenCalledWith({ messageId: REPLY, userId: "officer-1", rating: "down", note: "Wrong date" })
    await rateJackReply(REPLY, "up", "   ")
    expect(feedback.setReplyFeedback).toHaveBeenLastCalledWith({ messageId: REPLY, userId: "officer-1", rating: "up", note: null })
    await rateJackReply(REPLY, null)
    expect(feedback.setReplyFeedback).toHaveBeenLastCalledWith({ messageId: REPLY, userId: "officer-1", rating: null, note: null })
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("refuses a rating that isn't one, a long note, or an id that isn't one, and passes refusals on", async () => {
    expect(await rateJackReply(REPLY, "meh" as "up")).toEqual({ ok: false, error: "Pick thumbs up or down" })
    expect(await rateJackReply(REPLY, "down", "x".repeat(501))).toEqual({ ok: false, error: "Keep the note under 500 characters" })
    expect(await rateJackReply("../x", "up")).toEqual({ ok: false, error: "That reply doesn't exist anymore." })
    expect(feedback.setReplyFeedback).not.toHaveBeenCalled()
    feedback.setReplyFeedback.mockResolvedValue({ ok: false, error: "Wait for the reply to finish first." })
    expect(await rateJackReply(REPLY, "up")).toEqual({ ok: false, error: "Wait for the reply to finish first." })
  })
})
