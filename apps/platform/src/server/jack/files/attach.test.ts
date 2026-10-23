import type { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeFileDb } from "./test-db"

const db = vi.hoisted(() => ({ current: null as unknown }))
vi.mock("@/server/db", () => ({
  get prisma() {
    return db.current
  },
}))

import { AttachmentError, attachmentProblem, linkAttachments } from "./attach"

const ROOM = "11111111-1111-4111-8111-111111111111"
let fake: ReturnType<typeof createFakeFileDb>

beforeEach(() => {
  fake = createFakeFileDb()
  db.current = fake
  fake.addRoom(ROOM)
  fake.addFile({ id: "f1", roomId: ROOM, status: "READY", filename: "a.png" })
  fake.addFile({ id: "f2", roomId: ROOM, status: "READY", filename: "b.pdf" })
})

const tx = () => fake as unknown as Prisma.TransactionClient

describe("attachmentProblem", () => {
  it("passes the officer's own READY, unsent files in this room", async () => {
    expect(await attachmentProblem(ROOM, "officer-1", ["f1", "f2"])).toBeNull()
    expect(await attachmentProblem(ROOM, "officer-1", [])).toBeNull()
  })

  it("names what's wrong with a file", async () => {
    fake.addFile({ id: "up", roomId: ROOM, status: "UPLOADING", filename: "slow.pdf" })
    fake.addFile({ id: "bad", roomId: ROOM, status: "FAILED", filename: "bad.png" })
    fake.addFile({ id: "sent", roomId: ROOM, status: "READY", messageId: "m1", filename: "sent.png" })
    fake.addFile({ id: "theirs", roomId: ROOM, status: "READY", uploadedById: "officer-2", filename: "theirs.png" })
    fake.addFile({ id: "elsewhere", roomId: "other-room", status: "READY" })
    expect(await attachmentProblem(ROOM, "officer-1", ["up"])).toBe("slow.pdf is still uploading.")
    expect(await attachmentProblem(ROOM, "officer-1", ["bad"])).toBe("bad.png couldn't be read. Remove it, then send.")
    expect(await attachmentProblem(ROOM, "officer-1", ["sent"])).toBe("sent.png is already posted.")
    expect(await attachmentProblem(ROOM, "officer-1", ["theirs"])).toBe("theirs.png was attached by another officer.")
    expect(await attachmentProblem(ROOM, "officer-1", ["elsewhere"])).toContain("is gone")
    expect(await attachmentProblem(ROOM, "officer-1", ["missing"])).toContain("is gone")
    expect(await attachmentProblem(ROOM, "officer-1", ["f1", "f1"])).toBe("The same file is attached twice.")
    expect(await attachmentProblem(ROOM, "officer-1", Array.from({ length: 11 }, (_, i) => `x${i}`))).toBe("Up to 10 files per message.")
  })
})

describe("linkAttachments", () => {
  it("links the files to the message in the order given", async () => {
    await linkAttachments(tx(), { messageId: "m1", roomId: ROOM, officerId: "officer-1", fileIds: ["f2", "f1"] })
    expect(fake.file("f2")).toMatchObject({ messageId: "m1", position: 0 })
    expect(fake.file("f1")).toMatchObject({ messageId: "m1", position: 1 })
  })

  it("throws when a file was taken in the meantime, so the message isn't saved", async () => {
    await linkAttachments(tx(), { messageId: "m1", roomId: ROOM, officerId: "officer-1", fileIds: ["f1"] })
    // A second tab posting the same file at the same moment
    await expect(linkAttachments(tx(), { messageId: "m2", roomId: ROOM, officerId: "officer-1", fileIds: ["f1"] })).rejects.toThrow(AttachmentError)
    expect(fake.file("f1")?.messageId).toBe("m1")
  })
})
