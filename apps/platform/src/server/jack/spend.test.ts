import { describe, expect, it } from "vitest"
import { formatUsd, isOverBudget, spendBreakdown, spendLine } from "@/lib/jack/spend"
import { chicagoMonth, jackMonthlyBudgetUsd, summarizeSpend } from "./spend"

describe("chicagoMonth", () => {
  it("is the calendar month in Central Time, daylight saving or not", () => {
    // 8 PM CDT on Oct 31 is already Nov 1 in UTC, but still October here
    expect(chicagoMonth(new Date("2026-11-01T01:00:00.000Z"))).toEqual({
      start: new Date("2026-10-01T05:00:00.000Z"), // midnight CDT
      end: new Date("2026-11-01T05:00:00.000Z"), // midnight CDT (daylight saving ends at 2 AM that day)
      label: "October",
    })
    expect(chicagoMonth(new Date("2026-12-15T12:00:00.000Z"))).toEqual({
      start: new Date("2026-12-01T06:00:00.000Z"), // midnight CST
      end: new Date("2027-01-01T06:00:00.000Z"),
      label: "December",
    })
  })
})

describe("jackMonthlyBudgetUsd", () => {
  it("reads JACK_MONTHLY_BUDGET_USD, defaulting to $200", () => {
    expect(jackMonthlyBudgetUsd({})).toBe(200)
    expect(jackMonthlyBudgetUsd({ JACK_MONTHLY_BUDGET_USD: "50" })).toBe(50)
    expect(jackMonthlyBudgetUsd({ JACK_MONTHLY_BUDGET_USD: " 12.5 " })).toBe(12.5)
    expect(jackMonthlyBudgetUsd({ JACK_MONTHLY_BUDGET_USD: "0" })).toBe(0)
    expect(jackMonthlyBudgetUsd({ JACK_MONTHLY_BUDGET_USD: "lots" })).toBe(200)
    expect(jackMonthlyBudgetUsd({ JACK_MONTHLY_BUDGET_USD: "-5" })).toBe(200)
  })
})

describe("summarizeSpend", () => {
  it("splits by persona, counting costed system notes as Stand", () => {
    const spend = summarizeSpend(
      [
        { kind: "assistant", persona: "jack", costUsd: 2.25 },
        { kind: "assistant", persona: "lift", costUsd: 0.9 },
        { kind: "system", persona: null, costUsd: 0.05 },
      ],
      "October",
      200
    )
    expect(spend).toEqual({ month: "October", budgetUsd: 200, totalUsd: 3.2, byPersona: { jack: 2.25, lift: 0.9, stand: 0.05 } })
    expect(spendLine(spend)).toBe("October: $3.20 of $200 · Lift $0.90")
    expect(spendBreakdown(spend)).toBe("Jack $2.25 · Lift $0.90 · Stand $0.05")
    expect(isOverBudget(spend)).toBe(false)
  })

  it("leaves Lift out of the line until it has cost something", () => {
    const spend = summarizeSpend([{ kind: "assistant", persona: "jack", costUsd: 0.004 }], "November", 12.5)
    expect(spendLine(spend)).toBe("November: <$0.01 of $12.50")
    expect(isOverBudget({ totalUsd: 12.5, budgetUsd: 12.5 })).toBe(true)
  })
})

describe("formatUsd", () => {
  it("shows cents, or whole dollars for a round budget", () => {
    expect(formatUsd(0)).toBe("$0.00")
    expect(formatUsd(1234.5)).toBe("$1,234.50")
    expect(formatUsd(200, { wholeIfRound: true })).toBe("$200")
    expect(formatUsd(0.001)).toBe("<$0.01")
  })
})
