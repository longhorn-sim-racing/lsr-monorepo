import { describe, expect, it } from "vitest"
import { DEFAULT_TIMEZONE, dateToZonedValue, zoneLabel } from "./dates"

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
