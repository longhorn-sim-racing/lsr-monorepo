import { describe, expect, it } from "vitest"
import { outsideGap } from "./room-gap"

const at = (min: number) => new Date(Date.UTC(2026, 9, 19, 23, min)).toISOString()
const message = (id: string, min: number) => ({ id, createdAt: at(min) })

describe("outsideGap", () => {
  // The window ends at w2 (minute 2); the newest message when it loaded was n9 (minute 9)
  const gap = { after: { id: "w2", createdAt: at(2) }, through: { id: "n9", createdAt: at(9) } }

  it("keeps the window and anything newer than the gap, and drops what the gap holds", () => {
    const snapshot = [message("w1", 1), message("w2", 2), message("g3", 3), message("g8", 8), message("n9", 9), message("live", 10)]
    expect(outsideGap(snapshot, gap).map((m) => m.id)).toEqual(["w1", "w2", "live"])
  })

  it("orders messages written in the same millisecond by id, as snapshots do", () => {
    expect(outsideGap([message("w1", 2), message("w3", 2), message("n8", 9), message("na", 9)], gap).map((m) => m.id)).toEqual(["w1", "na"])
  })
})
