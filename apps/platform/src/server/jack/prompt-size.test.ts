import { describe, expect, it, vi } from "vitest"
import { SLOT_TRACKS } from "@/lib/slots"

// The real prompt, tools and kinds are measured; nothing touches a database
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import { deferredSize, loadedSize, measurePrompt, PREFIX_MAX_CHARS, proposeSize, TRACK_BUDGETS } from "./prompt-size"
import { KIND_SLOTS } from "./proposals/registry"

/**
 * The prompt size test (design §8): the cached prefix (system prompt plus the tool definitions every
 * request loads) and each track's share of it stay within their budgets as tracks merge.
 * `scripts/jack-prompt-size.ts` prints the same numbers as a table.
 */
describe("Jack's cached prefix", () => {
  const size = measurePrompt()

  it("stays within its budget, web tools on or off", () => {
    expect(size.prefix.noWeb).toBeLessThanOrEqual(size.prefix.web)
    expect(size.prefix.web).toBeLessThanOrEqual(PREFIX_MAX_CHARS)
  })

  it("keeps every track within its budget, in every request and behind tool search", () => {
    expect(Object.keys(TRACK_BUDGETS).sort()).toEqual([...SLOT_TRACKS].sort())
    for (const track of size.tracks) {
      expect(loadedSize(track), `${track.track}: in every request`).toBeLessThanOrEqual(TRACK_BUDGETS[track.track].loaded)
      expect(deferredSize(track), `${track.track}: behind tool search`).toBeLessThanOrEqual(TRACK_BUDGETS[track.track].deferred)
    }
  })

  it("adds up: the core tools, what the tracks add and what they share make the always-loaded definitions", () => {
    // Each part is measured on its own, not as what's left of the request's definitions, so a tool counted twice or left out shows here
    const tracks = size.tracks.reduce((n, t) => n + t.tools + t.kinds, 0)
    expect(size.coreTools + size.shared.toolSearch + size.shared.propose + tracks).toBe(size.tools)
    // Deferred tools are sent, but outside the prefix (the service tools are there), so the tool search tool is sent too
    expect(size.deferredTools).toBeGreaterThan(0)
    expect(size.shared.toolSearch).toBeGreaterThan(0)
    // The propose_* tools' leads and rules on tools several tracks use: small
    expect(size.shared.propose).toBeGreaterThan(0)
    expect(size.shared.propose).toBeLessThan(3_000)
    expect(size.system.jack).toBeGreaterThan(size.schemaNotes)
  })

  it("counts each track's kinds once: no more than its kinds' propose_* tools weigh on their own", () => {
    for (const track of size.tracks) {
      const alone = proposeSize(KIND_SLOTS[track.track]).loaded
      if (alone === 0) expect(track.kinds, track.track).toBe(0)
      else {
        expect(track.kinds, track.track).toBeGreaterThan(0)
        expect(track.kinds, track.track).toBeLessThanOrEqual(alone)
      }
    }
  })
})
