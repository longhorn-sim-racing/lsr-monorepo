import { describe, expect, it } from "vitest"
import { buildSystemPrompt } from "./prompt"

describe("buildSystemPrompt", () => {
  it("puts the schema notes after the core prompt, with the one cache breakpoint at the end", () => {
    const blocks = buildSystemPrompt("jack", { schemaNotes: "LSC paid means a league_access entitlement with a payment." })

    expect(blocks).toHaveLength(2)
    expect(blocks[0].cache_control).toBeUndefined()
    expect(blocks[1]).toEqual({
      type: "text",
      text: "# Notes on the database\n\nLSC paid means a league_access entitlement with a payment.",
      cache_control: { type: "ephemeral" },
    })
  })

  it("is fixed text per persona: the same every time, with nothing that changes per request", () => {
    const jack = buildSystemPrompt("jack", { schemaNotes: "" })
    expect(jack).toEqual(buildSystemPrompt("jack", { schemaNotes: "" }))
    expect(jack).toHaveLength(1)
    expect(jack[0].cache_control).toEqual({ type: "ephemeral" })
    expect(jack[0].text).toMatch(/^You are Jack/)
    expect(buildSystemPrompt("lift", { schemaNotes: "" })[0].text).toMatch(/^You are Lift/)
    const stand = buildSystemPrompt("stand", { schemaNotes: "" })[0].text
    expect(stand).toMatch(/^You are Stand/)
    expect(stand).toMatch(/suggest switching the room to Jack/)
    expect(jack[0].text).not.toMatch(/\b20\d\d\b/) // no dates
  })

  it("carries the rules officers rely on", () => {
    const text = buildSystemPrompt("jack", { schemaNotes: "" })[0].text
    for (const rule of [
      /read-only/,
      /Never move money/,
      /Central Time \(America\/Chicago\)/,
      /emails or EIDs/,
      /run_sql/,
      /describe_schema/,
      /chart tool/,
      /draft_event/,
      // Added after the eval: the commonest slip was adding background no tool gave
      /Say only what the tools returned/,
      /Give links exactly as a tool returns them/,
      /name them in your reply/,
      // Added after the second eval: name the page that does a change, instead of guessing another way
      /name the admin console page that does it/,
      /Products: prices, including the LSC entry fee/,
      /Members and roles: member profiles and roles/,
    ]) {
      expect(text).toMatch(rule)
    }
  })
})
