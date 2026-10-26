import { z } from "zod"
import { ACTION_ITEM_STATUSES, MEETING_LIMITS, MEETING_TYPES } from "@/lib/meetings"

/**
 * Meetings, decisions and action items, checked the same way from the Meetings and Action items pages,
 * Jack's proposals and the import target (#188). Blank text clears a field.
 */

const blankToNull = (value: unknown) => (typeof value === "string" && !value.trim() ? null : value)

const markdown = (what: string) =>
  z.preprocess(blankToNull, z.string().trim().max(MEETING_LIMITS.textMax, `Keep the ${what} to ${MEETING_LIMITS.textMax.toLocaleString("en-US")} characters.`).nullable())

/** Every field of a meeting, as the service stores them (`type` is Meeting.kind) */
export const meetingFieldsSchema = z.object({
  title: z.string().trim().min(3, "Give the meeting a title (3 characters or more).").max(MEETING_LIMITS.titleMax, `Keep the title to ${MEETING_LIMITS.titleMax} characters.`),
  type: z.enum(MEETING_TYPES),
  heldAt: z.date(),
  agendaMd: markdown("agenda").default(null),
  summaryMd: markdown("summary").default(null),
})

export type MeetingFields = z.output<typeof meetingFieldsSchema>

/** A change to a meeting: only the fields given change */
export const meetingChangesSchema = z.object({
  title: meetingFieldsSchema.shape.title.optional(),
  type: z.enum(MEETING_TYPES).optional(),
  heldAt: z.date().optional(),
  agendaMd: markdown("agenda").optional(),
  summaryMd: markdown("summary").optional(),
})

export type MeetingChanges = z.output<typeof meetingChangesSchema>

export const MEETING_FIELD_LABEL: Record<keyof MeetingFields, string> = {
  title: "Title",
  type: "Type",
  heldAt: "When",
  agendaMd: "Agenda",
  summaryMd: "Summary",
}

/** A decision: its text, and a short title for its decision-log entry (made from the text when left out) */
export const decisionInputSchema = z.object({
  text: z.string().trim().min(3, "Write the decision out.").max(MEETING_LIMITS.decisionMax, `Keep a decision to ${MEETING_LIMITS.decisionMax.toLocaleString("en-US")} characters.`),
  title: z.preprocess(blankToNull, z.string().trim().min(3).max(MEETING_LIMITS.decisionTitleMax).nullable()).default(null),
})

export type DecisionInput = z.output<typeof decisionInputSchema>

/** An action item's fields */
export const actionItemFieldsSchema = z.object({
  text: z.string().trim().min(3, "Say what needs doing.").max(MEETING_LIMITS.actionItemMax, `Keep an action item to ${MEETING_LIMITS.actionItemMax} characters.`),
  ownerId: z.preprocess(blankToNull, z.string().min(1).nullable()).default(null),
  dueAt: z.date().nullable().default(null),
})

export type ActionItemFields = z.output<typeof actionItemFieldsSchema>

export const actionItemChangesSchema = z.object({
  text: actionItemFieldsSchema.shape.text.optional(),
  ownerId: z.preprocess(blankToNull, z.string().min(1).nullable()).optional(),
  dueAt: z.date().nullable().optional(),
  status: z.enum(ACTION_ITEM_STATUSES).optional(),
})

export type ActionItemChanges = z.output<typeof actionItemChangesSchema>

export const ACTION_ITEM_FIELD_LABEL: Record<keyof ActionItemChanges, string> = { text: "Text", ownerId: "Owner", dueAt: "Due", status: "Status" }
