import { afterEach, describe, expect, it, vi } from "vitest"
import type { OverviewCard } from "./types"

const fakeCard = (id: string, order: number): OverviewCard => ({ id, order, Card: () => null })

afterEach(() => {
  vi.doUnmock("./sources-a")
  vi.doUnmock("./automation")
  vi.doUnmock("./discord-read")
  vi.doUnmock("./sources-b")
  vi.resetModules()
})

describe("the Overview card registry", () => {
  it("loads with unique ids", async () => {
    const { OVERVIEW_CARDS } = await import("./index")
    expect(new Set(OVERVIEW_CARDS.map((c) => c.id)).size).toBe(OVERVIEW_CARDS.length)
  })

  it("sorts the tracks' cards by order", async () => {
    vi.doMock("./sources-a", () => ({ CARDS: [fakeCard("site-traffic", 20)] }))
    vi.doMock("./automation", () => ({ CARDS: [fakeCard("needs-attention", 0)] }))
    vi.doMock("./discord-read", () => ({ CARDS: [fakeCard("discord-activity", 10)] }))
    vi.doMock("./sources-b", () => ({ CARDS: [] }))
    const { OVERVIEW_CARDS } = await import("./index")
    // Only the mocked ones: the tracks' real cards sit among them
    expect(OVERVIEW_CARDS.map((c) => c.id).filter((id) => ["needs-attention", "discord-activity", "site-traffic"].includes(id))).toEqual(["needs-attention", "discord-activity", "site-traffic"])
  })

  it("throws at load when two tracks register the same id", async () => {
    vi.doMock("./sources-a", () => ({ CARDS: [fakeCard("traffic", 1)] }))
    vi.doMock("./automation", () => ({ CARDS: [fakeCard("traffic", 2)] }))
    await expect(import("./index")).rejects.toThrow('Duplicate Overview card "traffic": registered by sources-a and automation')
  })
})
