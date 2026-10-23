import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import { kindsForTool } from "@/server/jack/proposals/registry"
import { JACK_TOOLS } from "../index"
import { TOOLS } from "./decks-rooms"

/** What the decks-rooms kinds add to propose_deck_publish's definition, in characters (design §8; about 2,900 now). It's deferred, so it loads only when tool search finds it */
const TRACK_KINDS_MAX_CHARS = 3_600

describe("the decks-rooms tools", () => {
  it("add no tools of their own: instagram.publish and gallery.add are kinds on propose_deck_publish, behind tool search", () => {
    expect(TOOLS).toEqual([])
    expect(kindsForTool("propose_deck_publish").map((k) => k.kind)).toEqual(["instagram.publish", "gallery.add"])
    const tool = JACK_TOOLS.find((t) => t.name === "propose_deck_publish")
    expect(tool?.deferred).toBe(true)
    expect(tool?.writes).toBe(true)
    expect(tool?.description).toMatch(/instagram\.publish: post a deck's slides/)
    expect(tool?.description).toMatch(/gallery\.add: add a deck's slides/)
  })

  it("keep the kinds' definitions small", () => {
    const kinds = kindsForTool("propose_deck_publish")
    const total = kinds.reduce((n, k) => n + k.description.length + JSON.stringify(z.toJSONSchema(k.schema)).length, 0)
    expect(total).toBeLessThanOrEqual(TRACK_KINDS_MAX_CHARS)
  })
})
