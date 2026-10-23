import { z } from "zod"
import { RECURRING_LIMITS, RECURRING_PERSONAS, recurringScheduleProblem, SCHEDULE_EVERY, WEEKDAYS, type RecurringSchedule } from "@/lib/jack/recurring"

/**
 * Recurring questions (#188, design §11.1), checked the same way from the Recurring questions page and
 * Jack's recurring.upsert proposal: a title, the question, the room it's asked in, who answers (Jack or
 * Stand) and a schedule that runs at most once a day.
 */

export const recurringScheduleSchema = z
  .object({
    every: z.enum(SCHEDULE_EVERY).describe("day: every day; weekday: Monday to Friday; week: on the days listed; month: once a month on dayOfMonth"),
    days: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional().describe('For every: "week": which days'),
    dayOfMonth: z.number().int().min(1).max(28).optional().describe('For every: "month": the date, 1 to 28'),
    time: z.string().trim().describe("Time of day, 24-hour Central Time, HH:MM (09:00)"),
  })
  .superRefine((schedule, ctx) => {
    const problem = recurringScheduleProblem(schedule as RecurringSchedule)
    if (problem) ctx.addIssue({ code: "custom", message: problem })
  })

export const recurringTitleSchema = z.string().trim().min(1, "Give it a title.").max(RECURRING_LIMITS.titleMax, `Keep the title to ${RECURRING_LIMITS.titleMax} characters.`)
export const recurringPromptSchema = z.string().trim().min(1, "Write the question.").max(RECURRING_LIMITS.promptMax, `Keep the question to ${RECURRING_LIMITS.promptMax.toLocaleString("en-US")} characters.`)

/** Every field of a recurring question */
export const recurringFieldsSchema = z.object({
  title: recurringTitleSchema,
  prompt: recurringPromptSchema,
  roomId: z.string().trim().min(1, "Pick a room.").max(100),
  persona: z.enum(RECURRING_PERSONAS),
  schedule: recurringScheduleSchema,
})

export type RecurringFields = z.output<typeof recurringFieldsSchema>

/** A change to one: only the fields given change */
export const recurringChangesSchema = recurringFieldsSchema.partial()

export type RecurringChanges = z.output<typeof recurringChangesSchema>

export const RECURRING_FIELD_LABEL: Record<keyof RecurringFields, string> = {
  title: "Title",
  prompt: "Question",
  roomId: "Room",
  persona: "Answered by",
  schedule: "When",
}
