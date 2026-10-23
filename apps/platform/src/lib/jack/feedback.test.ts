import { describe, expect, it } from "vitest"
import { feedbackTooltip, isFeedbackRating, summarizeFeedback, type FeedbackRow } from "./feedback"

const rating = (messageId: string, userId: string, value: string, note: string | null = null, name: string | null = userId): FeedbackRow => ({
  messageId,
  userId,
  rating: value,
  note,
  user: name ? { displayName: name } : null,
})

describe("summarizeFeedback", () => {
  it("counts each reply's thumbs, marks the viewer's own, and keeps everyone's in order", () => {
    const rows = [rating("r1", "gray", "up", null, "Gray"), rating("r1", "dylan", "down", "Wrong date", "Dylan"), rating("r2", "dylan", "up", null, "Dylan")]

    expect(summarizeFeedback(rows, "dylan")).toEqual({
      r1: {
        up: 1,
        down: 1,
        mine: { rating: "down", note: "Wrong date" },
        raters: [
          { userId: "gray", name: "Gray", rating: "up", note: null },
          { userId: "dylan", name: "Dylan", rating: "down", note: "Wrong date" },
        ],
      },
      r2: { up: 1, down: 0, mine: { rating: "up", note: null }, raters: [{ userId: "dylan", name: "Dylan", rating: "up", note: null }] },
    })
    expect(summarizeFeedback(rows, "alex").r1.mine).toBeNull()
  })

  it("skips ratings that aren't up or down, and names a rater whose account is gone", () => {
    const summary = summarizeFeedback([rating("r1", "x", "meh"), rating("r1", "y", "up", null, null)], "x")
    expect(summary.r1).toMatchObject({ up: 1, down: 0, mine: null, raters: [{ name: "An officer" }] })
    expect(isFeedbackRating("meh")).toBe(false)
  })

  it("lists who rated what for the tooltip", () => {
    const summary = summarizeFeedback([rating("r1", "gray", "up", null, "Gray"), rating("r1", "dylan", "down", "Wrong date", "Dylan")], "gray").r1
    expect(feedbackTooltip(summary)).toBe("Gray: thumbs up · Dylan: thumbs down, “Wrong date”")
  })
})
