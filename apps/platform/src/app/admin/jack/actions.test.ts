import { beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const rooms = vi.hoisted(() => ({ postOfficerMessage: vi.fn() }))
const attach = vi.hoisted(() => {
  class AttachmentError extends Error {}
  return { AttachmentError, attachmentProblem: vi.fn() }
})
const files = vi.hoisted(() => ({ createUpload: vi.fn(), removeUpload: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/jack/rooms", () => rooms)
vi.mock("@/server/jack/files/attach", () => attach)
vi.mock("@/server/jack/files/service", () => files)
vi.mock("@/server/audit/log", () => ({ createAuditLog: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { createJackUpload, postJackMessage, removeJackUpload } from "./actions"

const ROOM = "11111111-1111-4111-8111-111111111111"
const FILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const message = { id: "m1", roomId: ROOM, content: "" }

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  attach.attachmentProblem.mockResolvedValue(null)
  rooms.postOfficerMessage.mockResolvedValue(message)
})

describe("postJackMessage with files", () => {
  it("posts the files with the message, and lets the text be empty when there are files", async () => {
    expect(await postJackMessage(ROOM, "  ", [FILE])).toEqual({ ok: true, data: message })
    expect(attach.attachmentProblem).toHaveBeenCalledWith(ROOM, "officer-1", [FILE])
    expect(rooms.postOfficerMessage).toHaveBeenCalledWith(ROOM, "officer-1", "", expect.objectContaining({ fileIds: [FILE] }))
  })

  it("still needs text when there are no files, and works as before without them", async () => {
    expect(await postJackMessage(ROOM, "  ")).toEqual({ ok: false, error: "Type a message first" })
    expect(await postJackMessage(ROOM, "How many members?")).toEqual({ ok: true, data: message })
    expect(rooms.postOfficerMessage).toHaveBeenLastCalledWith(ROOM, "officer-1", "How many members?", expect.objectContaining({ fileIds: [] }))
  })

  it("refuses more than 10 files and ids that aren't ids", async () => {
    expect(await postJackMessage(ROOM, "hi", Array.from({ length: 11 }, () => FILE))).toEqual({ ok: false, error: "Up to 10 files per message" })
    expect(await postJackMessage(ROOM, "hi", ["../x"])).toMatchObject({ ok: false, error: expect.stringContaining("is gone") })
    expect(rooms.postOfficerMessage).not.toHaveBeenCalled()
  })

  it("says what's wrong with a file instead of posting", async () => {
    attach.attachmentProblem.mockResolvedValue("slow.pdf is still uploading.")
    expect(await postJackMessage(ROOM, "hi", [FILE])).toEqual({ ok: false, error: "slow.pdf is still uploading." })
    expect(rooms.postOfficerMessage).not.toHaveBeenCalled()
  })

  it("reports a file taken while sending, and nothing was posted", async () => {
    rooms.postOfficerMessage.mockRejectedValue(new attach.AttachmentError("One of the files changed while sending"))
    expect(await postJackMessage(ROOM, "hi", [FILE])).toEqual({ ok: false, error: "One of the files changed while sending" })
  })
})

describe("createJackUpload and removeJackUpload", () => {
  it("are for officers only", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("NotAuthorized"))
    await expect(createJackUpload({ roomId: ROOM, filename: "a.png", size: 5, type: "image/png" })).rejects.toThrow()
    await expect(removeJackUpload(FILE)).rejects.toThrow()
    expect(files.createUpload).not.toHaveBeenCalled()
  })

  it("start an upload as the signed-in officer and pass refusals on", async () => {
    const ticket = { file: { id: FILE, filename: "a.png", kind: "IMAGE", sizeBytes: 5 }, url: "https://x/upload", contentType: "image/png" }
    files.createUpload.mockResolvedValue({ ok: true, data: ticket })
    expect(await createJackUpload({ roomId: ROOM, filename: "a.png", size: 5, type: "image/png" })).toEqual({ ok: true, data: ticket })
    expect(files.createUpload).toHaveBeenCalledWith("officer-1", { roomId: ROOM, filename: "a.png", size: 5, type: "image/png" })
    files.createUpload.mockResolvedValue({ ok: false, code: "bad_request", error: "Archives can't be attached." })
    expect(await createJackUpload({ roomId: ROOM, filename: "a.zip", size: 5, type: "" })).toEqual({ ok: false, error: "Archives can't be attached." })
    expect(await createJackUpload({ roomId: "nope", filename: "a.png", size: 5, type: "" })).toMatchObject({ ok: false })
  })

  it("remove the officer's own unsent file", async () => {
    files.removeUpload.mockResolvedValue({ ok: true, data: null })
    expect(await removeJackUpload(FILE)).toEqual({ ok: true })
    expect(files.removeUpload).toHaveBeenCalledWith(FILE, "officer-1")
    files.removeUpload.mockResolvedValue({ ok: false, code: "bad_request", error: "This file is already posted in the room." })
    expect(await removeJackUpload(FILE)).toEqual({ ok: false, error: "This file is already posted in the room." })
  })
})
