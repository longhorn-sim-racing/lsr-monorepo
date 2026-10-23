import { describe, expect, it } from "vitest"
import { describeSchedule, nextRunAfter, nextRuns, normalizeSchedule, scheduleProblem } from "./schedule"

const iso = (dates: Date[]) => dates.map((d) => d.toISOString())

describe("job schedules", () => {
  it("takes five-field cron and nothing else", () => {
    for (const ok of ["* * * * *", "*/10 * * * *", "0 6 * * *", "30 9 * * MON-FRI", "0 0 1 * *", "  0   6 * * * "]) expect(scheduleProblem(ok), ok).toBeNull()
    expect(scheduleProblem("")).toMatch(/Enter a schedule/)
    expect(scheduleProblem("0 6 * *")).toMatch(/five fields/)
    expect(scheduleProblem("*/10 * * * * *")).toMatch(/five fields/) // a seconds field would run every 10 seconds
    expect(scheduleProblem("@daily")).toMatch(/five fields/)
    expect(scheduleProblem("H 6 * * *")).toMatch(/Random times/)
    expect(scheduleProblem("H/5 * * * *")).toMatch(/Random times/)
    expect(scheduleProblem("0 9 * * THU")).toBeNull() // the H in THU isn't a random time
    expect(scheduleProblem("61 * * * *")).toMatch(/can run/)
    expect(scheduleProblem("0 0 30 2 *")).toMatch(/can run/)
    expect(scheduleProblem("x".repeat(101))).toMatch(/too long/)
    expect(normalizeSchedule("  0   6 * * * ")).toBe("0 6 * * *")
  })

  it("computes the next run strictly after the given time, in Central time", () => {
    expect(nextRunAfter("0 6 * * *", new Date("2026-10-22T10:59:00Z")).toISOString()).toBe("2026-10-22T11:00:00.000Z") // 6 AM CDT
    expect(nextRunAfter("*/15 * * * *", new Date("2026-10-22T18:00:00.000Z")).toISOString()).toBe("2026-10-22T18:15:00.000Z")
    // Missed runs don't pile up: hours late, the next run is still the next one from now
    expect(nextRunAfter("0 * * * *", new Date("2026-10-22T21:37:00Z")).toISOString()).toBe("2026-10-22T22:00:00.000Z")
    expect(() => nextRunAfter("nope", new Date())).toThrow()
  })

  it("keeps a daily job at the same Central time when daylight saving ends (Nov 1, 2026)", () => {
    expect(iso(nextRuns("0 9 * * *", new Date("2026-10-31T12:00:00Z"), 3))).toEqual([
      "2026-10-31T14:00:00.000Z", // 9 AM CDT
      "2026-11-01T15:00:00.000Z", // 9 AM CST
      "2026-11-02T15:00:00.000Z",
    ])
    // 1:30 AM happens twice that night; the job runs once
    expect(iso(nextRuns("30 1 * * *", new Date("2026-10-31T12:00:00Z"), 2))).toEqual(["2026-11-01T06:30:00.000Z", "2026-11-02T07:30:00.000Z"])
    // An hourly job keeps running every real hour through the repeated hour
    expect(iso(nextRuns("0 * * * *", new Date("2026-11-01T05:30:00Z"), 3))).toEqual(["2026-11-01T06:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z"])
  })

  it("still runs once on the night clocks spring forward (Mar 14, 2027), when 2:30 AM doesn't exist", () => {
    expect(iso(nextRuns("30 2 * * *", new Date("2027-03-13T12:00:00Z"), 3))).toEqual([
      "2027-03-14T08:30:00.000Z", // 3:30 AM CDT, the first moment after the gap
      "2027-03-15T07:30:00.000Z", // 2:30 AM CDT
      "2027-03-16T07:30:00.000Z",
    ])
    expect(nextRunAfter("0 9 * * *", new Date("2027-03-13T16:00:00Z")).toISOString()).toBe("2027-03-14T14:00:00.000Z")
  })

  it("describes common schedules in words, and leaves the rest to the cron", () => {
    const cases: [string, string | null][] = [
      ["* * * * *", "Every minute"],
      ["*/10 * * * *", "Every 10 minutes"],
      ["0 * * * *", "Every hour, on the hour"],
      ["5 * * * *", "Every hour at :05"],
      ["15 */6 * * *", "Every 6 hours at :15"],
      // Steps start over each day or hour: */5 hours runs 20:00 then midnight, so it isn't "every 5 hours"
      ["0 */5 * * *", null],
      ["*/7 * * * *", null],
      ["*/15 * * * *", "Every 15 minutes"],
      ["0 6 * * *", "Daily at 6:00 AM CT"],
      ["30 18 * * *", "Daily at 6:30 PM CT"],
      ["0 0 * * *", "Daily at 12:00 AM CT"],
      ["0 12 * * *", "Daily at 12:00 PM CT"],
      ["0 8,20 * * *", "Daily at 8:00 AM and 8:00 PM CT"],
      ["0 9 * * 1-5", "Weekdays at 9:00 AM CT"],
      ["0 9 * * MON-FRI", "Weekdays at 9:00 AM CT"],
      ["0 10 * * 0,6", "Weekends at 10:00 AM CT"],
      ["0 9 * * 1", "Mondays at 9:00 AM CT"],
      ["0 9 * * 7", "Sundays at 9:00 AM CT"],
      ["0 9 * * 1,3,5", "Mondays, Wednesdays and Fridays at 9:00 AM CT"],
      ["0 9 * * 0-6", "Daily at 9:00 AM CT"],
      // 7 is Sunday too, but a range runs to it before it's read as 0
      ["0 9 * * 0-7", "Daily at 9:00 AM CT"],
      ["0 9 * * 1-7", "Daily at 9:00 AM CT"],
      ["0 9 * * 6-7", "Weekends at 9:00 AM CT"],
      ["0 6 1 * *", "Monthly on the 1st at 6:00 AM CT"],
      ["0 6 22 * *", "Monthly on the 22nd at 6:00 AM CT"],
      ["0 6 11 * *", "Monthly on the 11th at 6:00 AM CT"],
      ["0 9-17 * * *", null],
      ["0 6 1 1 *", null],
      ["0 6 1 * 1", null],
      ["0 9 * * 1#1", null],
      ["nope", null],
    ]
    for (const [schedule, words] of cases) expect(describeSchedule(schedule), schedule).toBe(words)
  })
})
