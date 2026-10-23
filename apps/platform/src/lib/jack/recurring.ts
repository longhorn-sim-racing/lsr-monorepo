/**
 * Recurring questions and the weekly digest (#188, design §11): shared by the Recurring questions page,
 * the recurring.upsert proposal, the scheduled jobs and the Usage page. A recurring question's schedule
 * lives only on its ScheduledJob (keyed "recurring:<id>"), as a five-field cron in Central Time; officers
 * and Jack pick it as one of four simple shapes (RecurringSchedule), so it never runs more than once a day.
 */

export const RECURRING_PAGE = "/admin/jack/recurring"

/** Where a recurring question's row is on its page (highlighted) */
export function recurringQuestionPath(id: string): string {
  return `${RECURRING_PAGE}?q=${encodeURIComponent(id)}`
}

/** The digest's settings, on the same page */
export const DIGEST_SETTINGS_PATH = `${RECURRING_PAGE}#digest`

/** The job kind every recurring question's ScheduledJob runs */
export const RECURRING_JOB_KIND = "recurring.question"
/** The weekly digest's job (one job: its key is its kind) */
export const DIGEST_JOB_KEY = "digest.weekly"
/** Mondays at 9:00 AM Central until an officer picks another day and time */
export const DIGEST_DEFAULT_SCHEDULE = "0 9 * * 1"

const RECURRING_KEY_PREFIX = "recurring:"

/** A recurring question's ScheduledJob.key, also on every note it posts (JackMessage.jobKey) */
export function recurringJobKey(questionId: string): string {
  return `${RECURRING_KEY_PREFIX}${questionId}`
}

/** The question id in a job key, or null when it isn't a recurring question's */
export function recurringIdFromJobKey(key: string | null | undefined): string | null {
  return key?.startsWith(RECURRING_KEY_PREFIX) ? key.slice(RECURRING_KEY_PREFIX.length) || null : null
}

/** Who answers a recurring question: Jack (Sonnet) or Stand (Haiku); never Lift (design §11.1) */
export const RECURRING_PERSONAS = ["jack", "stand"] as const
export type RecurringPersona = (typeof RECURRING_PERSONAS)[number]

export function isRecurringPersona(value: unknown): value is RecurringPersona {
  return typeof value === "string" && (RECURRING_PERSONAS as readonly string[]).includes(value)
}

export const RECURRING_LIMITS = { titleMax: 80, promptMax: 1_000 } as const

// ---------------------------------------------------------------------------
// schedules
// ---------------------------------------------------------------------------

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const WEEKDAY_LABEL: Record<Weekday, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" }

export const SCHEDULE_EVERY = ["day", "weekday", "week", "month"] as const
export type ScheduleEvery = (typeof SCHEDULE_EVERY)[number]

/**
 * How often a recurring question (or the digest) runs, in Central Time: every day, every weekday, on some
 * days of the week, or once a month (1st to 28th, so every month has it). One time of day, so never more
 * than once a day.
 */
export type RecurringSchedule = {
  every: ScheduleEvery
  /** "week": which days */
  days?: Weekday[]
  /** "month": the date, 1 to 28 */
  dayOfMonth?: number
  /** "09:00", 24-hour Central Time */
  time: string
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** [hour, minute] of an "HH:MM" time, or null when it isn't one */
export function parseTime(time: string): [number, number] | null {
  const match = TIME.exec(time.trim())
  return match ? [Number(match[1]), Number(match[2])] : null
}

/** Why a schedule can't be used, in a sentence for whoever picked it, or null when it's fine */
export function recurringScheduleProblem(schedule: RecurringSchedule): string | null {
  if (!(SCHEDULE_EVERY as readonly string[]).includes(schedule.every)) return "Pick every day, every weekday, some days of the week, or once a month."
  if (typeof schedule.time !== "string" || !parseTime(schedule.time)) return "Pick a time of day as HH:MM (24-hour, Central), like 09:00."
  if (schedule.every === "week" && !schedule.days?.length) return "Pick at least one day of the week."
  if (schedule.every === "week" && schedule.days!.some((day) => !(WEEKDAYS as readonly string[]).includes(day))) return "Days of the week are sun, mon, tue, wed, thu, fri and sat."
  if (schedule.every === "month" && !(Number.isInteger(schedule.dayOfMonth) && schedule.dayOfMonth! >= 1 && schedule.dayOfMonth! <= 28)) {
    return "Pick a day of the month from 1 to 28 (every month has those)."
  }
  return null
}

/** The five-field cron (Central Time) for a schedule. Throws on one recurringScheduleProblem() refuses */
export function cronFor(schedule: RecurringSchedule): string {
  const problem = recurringScheduleProblem(schedule)
  if (problem) throw new Error(problem)
  const [hour, minute] = parseTime(schedule.time)!
  const at = `${minute} ${hour}`
  if (schedule.every === "day") return `${at} * * *`
  if (schedule.every === "weekday") return `${at} * * 1-5`
  if (schedule.every === "month") return `${at} ${schedule.dayOfMonth} * *`
  const days = [...new Set(schedule.days!.map((day) => WEEKDAYS.indexOf(day)))].sort((a, b) => a - b)
  return days.length === 7 ? `${at} * * *` : `${at} * * ${days.join(",")}`
}

/** The schedule a cron came from (one cronFor makes), or null for any other cron */
export function scheduleFromCron(cron: string): RecurringSchedule | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || month !== "*") return null
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
  if (!parseTime(time)) return null
  if (dayOfMonth === "*" && dayOfWeek === "*") return { every: "day", time }
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return { every: "weekday", time }
  if (dayOfWeek === "*" && /^\d{1,2}$/.test(dayOfMonth)) {
    const day = Number(dayOfMonth)
    return day >= 1 && day <= 28 ? { every: "month", dayOfMonth: day, time } : null
  }
  if (dayOfMonth === "*" && /^[0-6](,[0-6])*$/.test(dayOfWeek)) {
    return { every: "week", days: [...new Set(dayOfWeek.split(",").map(Number))].sort((a, b) => a - b).map((d) => WEEKDAYS[d]), time }
  }
  return null
}

/**
 * Whether a cron runs at most once a day: a single minute and a single hour, whatever the days (design
 * §11.1). Recurring questions only ever get crons cronFor() makes, which pass; this is the guard on what's
 * saved
 */
export function isAtMostDaily(cron: string): boolean {
  const [minute, hour, ...rest] = cron.trim().split(/\s+/)
  return rest.length === 3 && /^\d{1,2}$/.test(minute ?? "") && /^\d{1,2}$/.test(hour ?? "")
}

/** About how many times a month a schedule runs (a year's runs over twelve) */
export function runsPerMonth(schedule: RecurringSchedule): number {
  if (schedule.every === "day") return 365.25 / 12
  if (schedule.every === "weekday") return 261 / 12
  if (schedule.every === "month") return 1
  return (new Set(schedule.days ?? []).size * 52.18) / 12
}

/** "9:00 AM" */
export function clockLabel(time: string): string {
  const parsed = parseTime(time)
  if (!parsed) return time
  const [hour, minute] = parsed
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`
}
