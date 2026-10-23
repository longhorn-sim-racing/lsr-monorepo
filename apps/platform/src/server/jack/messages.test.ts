import { describe, expect, it } from "vitest"
import { FORMER_OFFICER, toMessageView, type JackMessageRow } from "./messages"

function officerRow(author: JackMessageRow["author"]): JackMessageRow {
  return {
    id: "m1",
    roomId: "room-1",
    kind: "user",
    persona: null,
    authorUserId: author ? "officer-1" : null,
    author,
    content: "How many LSC entries?",
    toolCalls: null,
    status: "done",
    streamSeq: 0,
    answeredById: null,
    continues: false,
    createdAt: new Date("2026-10-22T20:00:00.000Z"),
  } as JackMessageRow
}

describe("toMessageView", () => {
  it("gives an officer message its author's name and picture", () => {
    expect(toMessageView(officerRow({ displayName: "Gray", avatarUrl: "https://example.com/gray.png" })).author).toEqual({
      kind: "user",
      userId: "officer-1",
      displayName: "Gray",
      avatarUrl: "https://example.com/gray.png",
    })
  })

  it("lists the files posted with it, in order, with thumbnails for photos (G5)", () => {
    const row = {
      ...officerRow({ displayName: "Gray", avatarUrl: null }),
      files: [
        { id: "f1", filename: "car.jpg", kind: "IMAGE", sizeBytes: 2_000, thumbPath: "rooms/r/f1/derived/thumb.jpg" },
        { id: "f2", filename: "rules.pdf", kind: "PDF", sizeBytes: 9_000, thumbPath: null },
      ],
    } as JackMessageRow
    expect(toMessageView(row).files).toEqual([
      { id: "f1", filename: "car.jpg", kind: "IMAGE", sizeBytes: 2_000, url: "/api/admin/jack/files/f1", thumbUrl: "/api/admin/jack/files/f1?variant=thumb" },
      { id: "f2", filename: "rules.pdf", kind: "PDF", sizeBytes: 9_000, url: "/api/admin/jack/files/f2" },
    ])
    expect(toMessageView(officerRow({ displayName: "Gray", avatarUrl: null }))).not.toHaveProperty("files")
  })

  it("marks a scheduled note and says whether a reply picked it up; other notes count as answered", () => {
    const note = { ...officerRow(null), kind: "system", authorUserId: "officer-1", scheduled: true } as JackMessageRow
    expect(toMessageView(note)).toMatchObject({ scheduled: true, answered: false })
    expect(toMessageView({ ...note, answeredById: "reply-1" })).toMatchObject({ scheduled: true, answered: true })
    const plain = toMessageView({ ...note, scheduled: false })
    expect(plain.answered).toBe(true)
    expect(plain).not.toHaveProperty("scheduled")
  })

  it("has no picture for an officer without one, or one who deleted their account", () => {
    expect(toMessageView(officerRow({ displayName: "Gray", avatarUrl: null })).author).toMatchObject({ avatarUrl: null })
    expect(toMessageView(officerRow(null)).author).toEqual({ kind: "user", userId: null, displayName: FORMER_OFFICER, avatarUrl: null })
  })
})
