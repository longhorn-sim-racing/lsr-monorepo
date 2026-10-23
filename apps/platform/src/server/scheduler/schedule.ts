import { CronExpressionParser } from "cron-parser"
import { DEFAULT_TIMEZONE } from "@/lib/dates"

/**
 * Job schedules (design §6): five-field cron, read in America/Chicago, so "0 6 * * *" is 6 AM Central all
 * year, across daylight saving. cron-parser (maintained, Luxon underneath) does the date math: on the
 * night clocks fall back a time that happens twice runs once, and one that doesn't exist on the spring
 * night runs an hour later that day.
 */

export const SCHEDULE_TIME_ZONE = DEFAULT_TIMEZONE

const MAX_SCHEDULE_CHARS = 100

/** The schedule with its fields separated by single spaces */
export function normalizeSchedule(schedule: string): string {
  return schedule.trim().split(/\s+/).join(" ")
}

/** Why a schedule can't be used, in a sentence for the officer who typed it, or null when it's fine */
export function scheduleProblem(schedule: string): string | null {
  const normalized = normalizeSchedule(schedule)
  if (!normalized) return "Enter a schedule."
  if (normalized.length > MAX_SCHEDULE_CHARS) return "That schedule is too long."
  const fields = normalized.split(" ")
  // cron-parser also takes a seconds field and @daily-style names; jobs use plain five-field cron only
  if (fields.length !== 5) return "Use five fields: minute, hour, day of month, month and day of week (0 6 * * * is 6 AM every day)."
  // H picks a random time each time it's read, which would move the job around
  if (fields.some((field) => /(^|[^a-z])h([^a-z]|$)/i.test(field))) return "Random times (H) aren't supported; pick a minute and hour."
  try {
    CronExpressionParser.parse(normalized, { currentDate: new Date(), tz: SCHEDULE_TIME_ZONE }).next()
  } catch (error) {
    return `That isn't a schedule that can run (${error instanceof Error ? error.message : String(error)}).`
  }
  return null
}

/** The first time the schedule fires strictly after `from`. Throws on a schedule scheduleProblem() refuses */
export function nextRunAfter(schedule: string, from: Date): Date {
  return nextRuns(schedule, from, 1)[0]
}

/** The next `count` times the schedule fires after `from` */
export function nextRuns(schedule: string, from: Date, count: number): Date[] {
  const problem = scheduleProblem(schedule)
  if (problem) throw new Error(problem)
  const expression = CronExpressionParser.parse(normalizeSchedule(schedule), { currentDate: from, tz: SCHEDULE_TIME_ZONE })
  return expression.take(count).map((date) => date.toDate())
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const DAY_ALIASES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

const NUMBER = /^\d{1,2}$/
const STEP = /^\*\/(\d{1,2})$/

/** "6:00 AM", "12:30 PM" */
function clock(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM"
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}:${String(minute).padStart(2, "0")} ${suffix}`
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/** A day-of-week field as words ("Weekdays", "Mondays and Fridays"), or null when it's not a simple one */
function describeDays(field: string): string | null {
  const day = (part: string): number | null => {
    const value = NUMBER.test(part) ? Number(part) : DAY_ALIASES[part.toLowerCase()]
    return value === undefined || value > 7 ? null : value % 7
  }
  const days = new Set<number>()
  for (const part of field.split(",")) {
    const range = part.split("-")
    if (range.length === 2) {
      const [from, to] = range.map(day)
      if (from === null || to === null || from > to) return null
      for (let d = from; d <= to; d++) days.add(d)
    } else {
      const d = day(part)
      if (d === null) return null
      days.add(d)
    }
  }
  const sorted = [...days].sort()
  if (sorted.join() === "1,2,3,4,5") return "Weekdays"
  if (sorted.join() === "0,6") return "Weekends"
  if (sorted.length === 7) return "Every day"
  return list(sorted.map((d) => `${DAYS[d]}s`))
}

/**
 * A schedule in words, for the Scheduled jobs page: "Every 10 minutes", "Daily at 6:00 AM CT", "Mondays and
 * Thursdays at 9:00 AM CT". Null for schedules that don't read simply; the page shows the cron and the
 * next run times instead.
 */
export function describeSchedule(schedule: string): string | null {
  if (scheduleProblem(schedule)) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = normalizeSchedule(schedule).split(" ")
  const anyDay = dayOfMonth === "*" && month === "*" && dayOfWeek === "*"

  // A step starts over each hour (minutes) or each day (hours), so only one that divides it evenly is "every N"
  if (anyDay && hour === "*") {
    if (minute === "*") return "Every minute"
    const step = STEP.exec(minute)
    if (step) {
      const n = Number(step[1])
      if (n === 0 || 60 % n !== 0) return null
      return n === 1 ? "Every minute" : `Every ${n} minutes`
    }
    if (NUMBER.test(minute)) return Number(minute) === 0 ? "Every hour, on the hour" : `Every hour at :${minute.padStart(2, "0")}`
    return null
  }
  if (!NUMBER.test(minute)) return null
  const m = Number(minute)
  if (anyDay) {
    const step = STEP.exec(hour)
    if (step) {
      const n = Number(step[1])
      return n > 0 && 24 % n === 0 ? `Every ${n} hours at :${String(m).padStart(2, "0")}` : null
    }
  }

  const hours = hour.split(",")
  if (hours.length > 3 || !hours.every((h) => NUMBER.test(h))) return null
  const times = `${list(hours.map((h) => clock(Number(h), m)))} CT`
  if (month !== "*") return null
  if (dayOfMonth === "*" && dayOfWeek === "*") return `Daily at ${times}`
  if (dayOfMonth === "*") {
    const days = describeDays(dayOfWeek)
    if (!days) return null
    return days === "Every day" ? `Daily at ${times}` : `${days} at ${times}`
  }
  if (dayOfWeek === "*" && NUMBER.test(dayOfMonth)) return `Monthly on the ${ordinal(Number(dayOfMonth))} at ${times}`
  return null
}
