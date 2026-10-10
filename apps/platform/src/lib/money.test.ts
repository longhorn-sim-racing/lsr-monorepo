import { describe, expect, it } from "vitest"
import { centsToDollarInput, dollarsToCents, formatCents, formatCentsShort } from "./money"

describe("formatCents", () => {
  it.each([
    [0, "$0.00"],
    [50, "$0.50"],
    [1050, "$10.50"],
    [123456, "$1,234.56"],
  ])("%i → %s", (cents, expected) => {
    expect(formatCents(cents)).toBe(expected)
  })
})

describe("formatCentsShort", () => {
  it("drops the cents on whole dollars", () => {
    expect(formatCentsShort(1000)).toBe("$10")
    expect(formatCentsShort(0)).toBe("$0")
  })

  it("keeps the cents otherwise", () => {
    expect(formatCentsShort(1050)).toBe("$10.50")
    expect(formatCentsShort(5)).toBe("$0.05")
  })
})

describe("centsToDollarInput", () => {
  it("formats for a form input, empty for no value", () => {
    expect(centsToDollarInput(1050)).toBe("10.50")
    expect(centsToDollarInput(0)).toBe("0.00")
    expect(centsToDollarInput(null)).toBe("")
    expect(centsToDollarInput(undefined)).toBe("")
  })
})

describe("dollarsToCents", () => {
  it.each([
    ["10", 1000],
    ["10.5", 1050],
    ["10.50", 1050],
    ["$10.50", 1050],
    [" 12.99 ", 1299],
    ["0.99", 99],
    [".5", 50],
    ["10.", 1000],
  ])("parses %j as %i cents", (input, expected) => {
    expect(dollarsToCents(input)).toBe(expected)
  })

  it.each(["", "abc", "10.555", "1,000", "-5", "$", "."])("rejects %j", (input) => {
    expect(dollarsToCents(input)).toBeNull()
  })

  it("avoids float rounding", () => {
    // parseFloat("19.99") * 100 is 1998.9999999999998
    expect(dollarsToCents("19.99")).toBe(1999)
  })
})
