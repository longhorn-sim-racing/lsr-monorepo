import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ jackMessage: { findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { captionCounts, captionProblem, hiddenTextProblem, latestCaptionDraft } from "./caption"

const draft = (draftKind: string, body: string, status = "done") => ({ id: "t1", name: "draft_text", label: "Drafted", status, at: 0, input: {}, displays: [{ kind: "text_draft", draftKind, body }] })

beforeEach(() => {
  db.jackMessage.findMany.mockReset()
})

describe("captions", () => {
  it("counts characters, hashtags and @-tags (not email addresses)", () => {
    expect(captionCounts("GM 2! #LSR #simracing with @lsr_media and @Lsr_Media, mail us at hi@longhornsimracing.org")).toEqual({ characters: 89, hashtags: 2, tags: ["lsr_media"] })
  })

  it("refuses what Instagram refuses: over 2,200 characters, 30 hashtags or 20 tags", () => {
    expect(captionProblem("Fine #one @two")).toBeNull()
    expect(captionProblem("x".repeat(2_201))).toMatch(/at most 2,200 characters; this one has 2,201/)
    expect(captionProblem(Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" "))).toMatch(/at most 30 hashtags; this caption has 31/)
    expect(captionProblem(Array.from({ length: 21 }, (_, i) => `@user${i}`).join(" "))).toMatch(/at most 20 @-tags; this caption has 21/)
  })

  it("refuses characters that don't show (the officer approving it would never see them), but keeps flags and joined emoji", () => {
    expect(captionProblem("GM 2 recap!\u{e006a}\u{e006f}")).toBe("The caption has 2 characters that don't show on screen (U+E006A, U+E006F). Write it again without them: every character that's posted has to show where it's approved.")
    expect(captionProblem("GM​ 2")).toBe("The caption has a character that doesn't show on screen (U+200B). Write it again without it: every character that's posted has to show where it's approved.")
    expect(captionProblem("a​b‌c‍d‎e‮f⁦")).toMatch(/has 6 characters that don't show on screen \(U\+200B, U\+200C, U\+200D, U\+200E and 2 more\)/)
    expect(captionProblem("Come on England \u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} 🏎️ 👩🏽‍💻\n\n#LSR")).toBeNull()
  })

  it("holds alt text to the same rule, without the emoji allowances", () => {
    expect(hiddenTextProblem("The alt text", "Three drivers on the podium")).toBeNull()
    expect(hiddenTextProblem("The alt text", "podium\u{e0061}\u{e0062}")).toMatch(/^The alt text has 2 characters that don't show on screen \(U\+E0061, U\+E0062\)/)
    expect(hiddenTextProblem("The alt text", "Coders 👩🏽‍💻")).toMatch(/U\+200D/)
  })

  it("finds the newest caption Jack drafted in the room, skipping other drafts and failed calls", async () => {
    db.jackMessage.findMany.mockResolvedValue([
      { toolCalls: [draft("email", "Hi Jordan"), draft("caption", "Not this one", "error")] },
      { toolCalls: [draft("caption", "First try"), draft("caption", "GM 2 recap! #LSR")] },
    ])
    expect(await latestCaptionDraft("room-1")).toBe("GM 2 recap! #LSR")
    expect(db.jackMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { roomId: "room-1", kind: "assistant", toolCalls: { array_contains: [{ name: "draft_text" }] } }, orderBy: { createdAt: "desc" } }))
    expect(await latestCaptionDraft(null)).toBeNull()
    db.jackMessage.findMany.mockResolvedValue([{ toolCalls: [draft("agenda", "1. Hello")] }])
    expect(await latestCaptionDraft("room-1")).toBeNull()
  })
})
