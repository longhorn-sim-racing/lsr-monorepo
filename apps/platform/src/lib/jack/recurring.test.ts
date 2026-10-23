import { describe, expect, it } from "vitest"
import { describeSchedule, nextRuns } from "@/server/scheduler/schedule"
import {
  clockLabel,
  cronFor,
  isAtMostDaily,
  recurringIdFromJobKey,
  recurringJobKey,
  recurringQuestionPath,
  recurringScheduleProblem,
  runsPerMonth,
  scheduleFromCron,
  type RecurringSchedule,
} from "./recurring"

describe("recurring question schedules", () => {
  it("turn each shape into a five-field cron, read in Central Time", () => {
    expect(cronFor({ every: "day", time: "09:00" })).toBe("0 9 * * *")
    expect(cronFor({ every: "weekday", time: "7:30" })).toBe("30 7 * * 1-5")
    expect(cronFor({ every: "week", days: ["thu", "mon", "mon"], time: "18:05" })).toBe("5 18 * * 1,4")
    expect(cronFor({ every: "week", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], time: "09:00" })).toBe("0 9 * * *")
    expect(cronFor({ every: "month", dayOfMonth: 1, time: "23:59" })).toBe("59 23 1 * *")
    // The scheduler reads them the same way
    expect(describeSchedule(cronFor({ every: "week", days: ["mon", "thu"], time: "09:00" }))).toBe("Mondays and Thursdays at 9:00 AM CT")
  })

  it("read back the shape they came from, and nothing else", () => {
    const shapes: RecurringSchedule[] = [
      { every: "day", time: "09:00" },
      { every: "weekday", time: "07:30" },
      { every: "week", days: ["mon", "thu"], time: "18:05" },
      { every: "month", dayOfMonth: 28, time: "00:00" },
    ]
    for (const shape of shapes) expect(scheduleFromCron(cronFor(shape))).toEqual(shape)
    expect(scheduleFromCron("*/10 * * * *")).toBeNull()
    expect(scheduleFromCron("0 9,17 * * *")).toBeNull()
    expect(scheduleFromCron("0 9 31 * *")).toBeNull()
    expect(scheduleFromCron("0 9 * 1 *")).toBeNull()
    expect(scheduleFromCron("0 9 * * MON")).toBeNull()
  })

  it("refuse what could run more than once a day, or not every month", () => {
    expect(recurringScheduleProblem({ every: "day", time: "25:00" })).toMatch(/HH:MM/)
    expect(recurringScheduleProblem({ every: "day", time: "9am" })).toMatch(/HH:MM/)
    expect(recurringScheduleProblem({ every: "week", days: [], time: "09:00" })).toMatch(/at least one day/)
    expect(recurringScheduleProblem({ every: "week", days: ["funday" as never], time: "09:00" })).toMatch(/sun, mon/)
    expect(recurringScheduleProblem({ every: "month", dayOfMonth: 31, time: "09:00" })).toMatch(/1 to 28/)
    expect(recurringScheduleProblem({ every: "hour" as never, time: "09:00" })).toMatch(/every day/)
    expect(() => cronFor({ every: "month", time: "09:00" })).toThrow(/1 to 28/)
    expect(recurringScheduleProblem({ every: "weekday", time: "09:00" })).toBeNull()
  })

  it("count a cron as daily at most only with one minute and one hour", () => {
    expect(isAtMostDaily("0 9 * * *")).toBe(true)
    expect(isAtMostDaily("15 18 1 * *")).toBe(true)
    expect(isAtMostDaily("0 9,17 * * *")).toBe(false)
    expect(isAtMostDaily("*/30 9 * * *")).toBe(false)
    expect(isAtMostDaily("0 * * * *")).toBe(false)
    expect(isAtMostDaily("0 9 * *")).toBe(false)
  })

  it("never fire twice in a day, across daylight saving's end", () => {
    // Nov 1, 2026: 1:30 AM CT happens twice; the question still runs once that day
    const runs = nextRuns(cronFor({ every: "day", time: "01:30" }), new Date("2026-10-30T12:00:00Z"), 5)
    const days = runs.map((run) => run.toLocaleDateString("en-US", { timeZone: "America/Chicago" }))
    expect(new Set(days).size).toBe(days.length)
  })

  it("estimate how many runs a month", () => {
    expect(runsPerMonth({ every: "day", time: "09:00" })).toBeCloseTo(30.44, 1)
    expect(runsPerMonth({ every: "weekday", time: "09:00" })).toBeCloseTo(21.75, 1)
    expect(runsPerMonth({ every: "week", days: ["mon", "thu"], time: "09:00" })).toBeCloseTo(8.7, 1)
    expect(runsPerMonth({ every: "month", dayOfMonth: 1, time: "09:00" })).toBe(1)
  })

  it("show a time on a 12-hour clock", () => {
    expect(clockLabel("09:00")).toBe("9:00 AM")
    expect(clockLabel("00:05")).toBe("12:05 AM")
    expect(clockLabel("12:30")).toBe("12:30 PM")
    expect(clockLabel("nope")).toBe("nope")
  })
})

describe("job keys", () => {
  it("name a question's job and its notes, and read the id back", () => {
    expect(recurringJobKey("q-1")).toBe("recurring:q-1")
    expect(recurringIdFromJobKey("recurring:q-1")).toBe("q-1")
    expect(recurringIdFromJobKey("digest.weekly")).toBeNull()
    expect(recurringIdFromJobKey("recurring:")).toBeNull()
    expect(recurringIdFromJobKey(null)).toBeNull()
    expect(recurringQuestionPath("q 1")).toBe("/admin/jack/recurring?q=q%201")
  })
})
