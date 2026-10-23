import { describe, expect, it } from "vitest"
import { byOrder, joinSlots, SLOT_TRACKS } from "./slots"

const key = (item: { id: string }) => item.id

describe("joinSlots", () => {
  it("joins slots in track order, whatever order the object lists them in", () => {
    const joined = joinSlots("thing", { automation: [{ id: "c" }], groundwork: [{ id: "a" }], "club-data": [{ id: "b" }] }, key)
    expect(joined.map(key)).toEqual(["a", "b", "c"])
  })

  it("skips tracks without a slot and keeps each slot's own order", () => {
    expect(joinSlots("thing", { memory: [{ id: "x" }, { id: "y" }] }, key).map(key)).toEqual(["x", "y"])
    expect(joinSlots("thing", {}, key)).toEqual([])
  })

  it("throws on a key two tracks share, naming both", () => {
    expect(() => joinSlots("proposal kind", { changes: [{ id: "event.update" }], "discord-post": [{ id: "event.update" }] }, key)).toThrow(
      'Duplicate proposal kind "event.update": registered by changes and discord-post',
    )
  })

  it("throws on a key repeated inside one track's slot", () => {
    expect(() => joinSlots("job kind", { memory: [{ id: "a" }, { id: "a" }] }, key)).toThrow('Duplicate job kind "a": registered by memory twice')
  })

  it("throws when a listed slot isn't loaded yet, the sign of an import cycle", () => {
    const unloaded = { memory: [{ id: "a" }], changes: undefined } as unknown as Record<string, { id: string }[]>
    expect(() => joinSlots("proposal kind", unloaded, key)).toThrow("The changes slot of the proposal kind registry isn't initialized: an import cycle?")
  })

  it("fails loudly when a slot file imports its own registry and is loaded first", async () => {
    // slot.ts imports registry.ts, which joins slot.ts's ITEMS before slot.ts has finished loading
    await expect(import("./__fixtures__/slot-cycle/slot")).rejects.toThrow("The groundwork slot of the fixture item registry isn't initialized: an import cycle?")
  })

  it("has every track once, groundwork first", () => {
    expect(new Set(SLOT_TRACKS).size).toBe(SLOT_TRACKS.length)
    expect(SLOT_TRACKS[0]).toBe("groundwork")
  })
})

describe("byOrder", () => {
  it("sorts by order and keeps ties in slot order", () => {
    const items = [
      { id: "late", order: 20 },
      { id: "tie-1", order: 10 },
      { id: "tie-2", order: 10 },
    ]
    expect(byOrder(items).map(key)).toEqual(["tie-1", "tie-2", "late"])
    expect(items[0].id).toBe("late") // the input isn't sorted in place
  })
})
