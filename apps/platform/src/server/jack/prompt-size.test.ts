import { describe, expect, it, vi } from "vitest"
import { SLOT_TRACKS } from "@/lib/slots"

// The real prompt, tools and kinds are measured; nothing touches a database
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import { deferredSize, loadedSize, measurePrompt, PREFIX_MAX_CHARS, TRACK_BUDGETS } from "./prompt-size"

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
    const tracks = size.tracks.reduce((n, t) => n + t.tools + t.kinds, 0)
    expect(size.coreTools + size.shared + tracks).toBe(size.tools)
    // What's shared is the propose_* tools' leads and rules on tools several tracks use, and the tool search tool: small
    expect(size.shared).toBeGreaterThan(0)
    expect(size.shared).toBeLessThan(3_000)
    // Deferred tools are sent, but outside the prefix; the service tools are there
    expect(size.deferredTools).toBeGreaterThan(0)
    expect(size.system.jack).toBeGreaterThan(size.schemaNotes)
  })
})
