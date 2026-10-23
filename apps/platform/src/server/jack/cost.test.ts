import { describe, expect, it } from "vitest"
import { costUsd, LONG_PROMPT_PRICES, MODEL_PRICES, UsageTally, usageByModel } from "./cost"

const M = 1_000_000

describe("costUsd", () => {
  it("prices each kind of token at its own rate", () => {
    const sonnet = "claude-sonnet-5-5"
    expect(costUsd(sonnet, { inputTokens: M, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 })).toBe(2)
    expect(costUsd(sonnet, { inputTokens: 0, cacheWriteTokens: M, cacheReadTokens: 0, outputTokens: 0 })).toBe(2.5) // 1.25x input
    expect(costUsd(sonnet, { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: M, outputTokens: 0 })).toBe(0.1) // 0.05x input
    expect(costUsd(sonnet, { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: M })).toBe(10)
  })

  it("has the persona models at the listed prices", () => {
    expect(MODEL_PRICES["claude-opus-5-5"]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(MODEL_PRICES["claude-haiku-5-5"]).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 })
  })

  it("adds a typical Lift reply up and rounds to six decimals", () => {
    // 2,000 new + 6,000 written + 30,000 read in, 1,500 out
    const cost = costUsd("claude-opus-5-5", { inputTokens: 2_000, cacheWriteTokens: 6_000, cacheReadTokens: 30_000, outputTokens: 1_500 })
    expect(cost).toBe(0.074) // 0.008 + 0.03 + 0.006 + 0.03
  })

  it("prices an unknown model like the one asked for, and refuses with nothing to go on", () => {
    const usage = { inputTokens: M, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
    expect(costUsd("claude-new-thing", usage, "claude-opus-5-5")).toBe(4)
    expect(() => costUsd("claude-new-thing", usage)).toThrow()
  })
})

describe("usageByModel", () => {
  const usage = (fields: Record<string, unknown>) => ({
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
    iterations: null,
    ...fields,
  })

  it("uses the top-level numbers for an ordinary response", () => {
    const byModel = usageByModel({ model: "claude-sonnet-5-5", usage: usage({}) as never }, "claude-sonnet-5-5")
    expect([...byModel]).toEqual([["claude-sonnet-5-5", { inputTokens: 10, cacheWriteTokens: 20, cacheReadTokens: 100, outputTokens: 5 }]])
  })

  it("splits a refusal fallback by the model each attempt ran on", () => {
    const iterations = [
      { type: "message", model: "claude-sonnet-5-5", input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: "fallback_message", model: "claude-sonnet-5", input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: "compaction", input_tokens: 9_999, output_tokens: 9_999 },
    ]
    const byModel = usageByModel({ model: "claude-sonnet-5", usage: usage({ iterations }) as never }, "claude-sonnet-5-5")
    expect(byModel.get("claude-sonnet-5-5")).toEqual({ inputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10 })
    expect(byModel.get("claude-sonnet-5")).toEqual({ inputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 200 })
    expect(byModel.size).toBe(2)
  })
})

describe("UsageTally", () => {
  it("sums a reply's calls, across models, with the requested model first", () => {
    const tally = new UsageTally("claude-opus-5-5")
    tally.add({ model: "claude-opus-5-5", usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 4_000, iterations: null } as never })
    tally.add({ model: "claude-opus-5-5", usage: { input_tokens: 200, output_tokens: 300, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 0, iterations: null } as never })
    tally.add({
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [{ type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
      } as never,
    })

    expect(tally.calls).toBe(3)
    expect(tally.tokens).toEqual({ inputTokens: 1_300, cacheWriteTokens: 4_000, cacheReadTokens: 5_000, outputTokens: 500 })
    expect(tally.models).toEqual(["claude-opus-5-5", "claude-opus-4-8"])
    const opus55 = (1_200 * 4 + 4_000 * 5 + 5_000 * 0.2 + 400 * 20) / M
    const opus48 = (100 * 5 + 100 * 25) / M
    expect(tally.costUsd).toBeCloseTo(opus55 + opus48, 6)
  })

  it("reports the requested model before any call", () => {
    expect(new UsageTally("claude-sonnet-5-5").models).toEqual(["claude-sonnet-5-5"])
  })
})

describe("Haiku's long-prompt rates", () => {
  const haiku = "claude-haiku-5-5"
  const reply = (input: number, cacheRead: number, output: number) => ({
    model: haiku,
    usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output, iterations: null } as never,
  })

  it("bills a request whose prompt is over 100K tokens at the higher rates, the whole request", () => {
    expect(LONG_PROMPT_PRICES[haiku]).toEqual({ overTokens: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } })
    // 20K uncached + 90K cache read = a 110K prompt: every token at the long rates
    expect(costUsd(haiku, { inputTokens: 20_000, cacheWriteTokens: 0, cacheReadTokens: 90_000, outputTokens: 1_000 })).toBeCloseTo(
      (20_000 * 0.5 + 90_000 * 0.05 + 1_000 * 2.5) / 1_000_000,
      6
    )
    // Exactly 100K is still the normal rates
    expect(costUsd(haiku, { inputTokens: 100_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 })).toBeCloseTo(0.01, 6)
  })

  it("decides per request, not on a reply's total", () => {
    const tally = new UsageTally(haiku)
    tally.add(reply(5_000, 50_000, 500)) // 55K prompt: normal rates
    tally.add(reply(5_000, 105_000, 500)) // 110K prompt: long rates
    const short = (5_000 * 0.1 + 50_000 * 0.01 + 500 * 0.5) / 1_000_000
    const long = (5_000 * 0.5 + 105_000 * 0.05 + 500 * 2.5) / 1_000_000
    expect(tally.costUsd).toBeCloseTo(short + long, 6)
  })

  it("leaves the other models at their one rate", () => {
    expect(costUsd("claude-sonnet-5-5", { inputTokens: 200_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 })).toBeCloseTo(0.4, 6)
  })
})
