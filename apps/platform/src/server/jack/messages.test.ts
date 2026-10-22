import { describe, expect, it } from "vitest"
import { toMessageView, type JackMessageRow } from "./messages"

describe("toMessageView", () => {
  it("includes an officer's avatar URL", () => {
    const row = {
      id: "message-1",
      roomId: "room-1",
      kind: "user",
      persona: null,
      authorUserId: "officer-1",
      author: { displayName: "Alex Officer", avatarUrl: "https://example.com/avatar.png" },
      content: "Hello",
      toolCalls: null,
      status: "done",
      streamSeq: 0,
      answeredById: null,
      continues: false,
      createdAt: new Date("2026-10-22T12:00:00.000Z"),
    } as unknown as JackMessageRow

    expect(toMessageView(row).author).toEqual({
      kind: "user",
      userId: "officer-1",
      displayName: "Alex Officer",
      avatarUrl: "https://example.com/avatar.png",
    })
  })
})
