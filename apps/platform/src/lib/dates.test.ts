import { describe, expect, it } from "vitest"
import { chicagoDay, DEFAULT_TIMEZONE, dateToZonedValue, zoneLabel } from "./dates"

describe("zoneLabel", () => {
  it("says CT for Central time, in daylight and standard time alike", () => {
    expect(zoneLabel(new Date("2026-07-01T17:00:00Z"), DEFAULT_TIMEZONE)).toBe("CT")
    expect(zoneLabel(new Date("2026-12-01T17:00:00Z"), DEFAULT_TIMEZONE)).toBe("CT")
  })

  it("uses the short zone name elsewhere", () => {
    expect(zoneLabel(new Date("2026-07-01T17:00:00Z"), "America/New_York")).toBe("EDT")
    expect(zoneLabel(new Date("2026-12-01T17:00:00Z"), "America/New_York")).toBe("EST")
    expect(zoneLabel(new Date("2026-07-01T17:00:00Z"), "UTC")).toBe("UTC")
  })
})

describe("dateToZonedValue", () => {
  it("formats an instant for a datetime-local input in the given zone", () => {
    expect(dateToZonedValue(new Date("2026-10-21T00:00:00Z"), DEFAULT_TIMEZONE)).toBe("2026-10-20T19:00")
    expect(dateToZonedValue(new Date("2026-12-01T18:30:00Z"), DEFAULT_TIMEZONE)).toBe("2026-12-01T12:30")
  })

  it("is empty for no date", () => {
    expect(dateToZonedValue(null, DEFAULT_TIMEZONE)).toBe("")
    expect(dateToZonedValue(undefined, DEFAULT_TIMEZONE)).toBe("")
  })
})

describe("chicagoDay", () => {
  it("keys an evening in Central time to that day, not the next UTC day", () => {
    // 11:30 PM CDT on Oct 22 is 04:30 UTC on Oct 23
    expect(chicagoDay(new Date("2026-10-23T04:30:00Z")).toISOString()).toBe("2026-10-22T00:00:00.000Z")
    // 11:30 PM CST on Dec 1 is 05:30 UTC on Dec 2
    expect(chicagoDay(new Date("2026-12-02T05:30:00Z")).toISOString()).toBe("2026-12-01T00:00:00.000Z")
  })

  it("rolls over at midnight Central time", () => {
    expect(chicagoDay(new Date("2026-10-23T05:00:00Z")).toISOString()).toBe("2026-10-23T00:00:00.000Z")
  })
})
