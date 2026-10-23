import { formatInTimeZone, fromZonedTime } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"

/**
 * Meetings, their decisions and action items (#188, design §3.3 and §13). Shared by the Meetings and
 * Action items pages, Jack's tools and proposals, and the digest checks. A decision is also kept in the
 * knowledge base's decision log (an entry tagged "decision").
 */

/** Meeting.kind */
export const MEETING_TYPES = ["board", "tech", "general", "department", "other"] as const
export type MeetingType = (typeof MEETING_TYPES)[number]

export const MEETING_TYPE_LABEL: Record<MeetingType, string> = {
  board: "Board",
  tech: "Tech",
  general: "General",
  department: "Department",
  other: "Other",
}

export function isMeetingType(value: unknown): value is MeetingType {
  return typeof value === "string" && (MEETING_TYPES as readonly string[]).includes(value)
}

export function meetingTypeLabel(type: string): string {
  return MEETING_TYPE_LABEL[type as MeetingType] ?? type
}

/** ActionItem.status */
export const ACTION_ITEM_STATUSES = ["open", "done", "dropped"] as const
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number]

export const ACTION_ITEM_STATUS_LABEL: Record<ActionItemStatus, string> = { open: "Open", done: "Done", dropped: "Dropped" }

export function isActionItemStatus(value: unknown): value is ActionItemStatus {
  return typeof value === "string" && (ACTION_ITEM_STATUSES as readonly string[]).includes(value)
}

/** The tag every decision-log entry in the knowledge base carries */
export const DECISION_TAG = "decision"

export const MEETINGS_PAGE = "/admin/meetings"
export const ACTION_ITEMS_PAGE = "/admin/action-items"
export const meetingPath = (id: string) => `/admin/meetings/${id}`
export const meetingAgendaPath = (id: string) => `/admin/meetings/${id}/agenda`
/** The Action items page for one officer's items */
export const ownerItemsPath = (handle: string) => `${ACTION_ITEMS_PAGE}?owner=${encodeURIComponent(handle)}`

/** Limits, shared by the forms, the services and Jack's proposals */
export const MEETING_LIMITS = {
  titleMax: 120,
  /** Agenda and summary, Markdown */
  textMax: 20_000,
  decisionMax: 1_000,
  decisionTitleMax: 120,
  actionItemMax: 500,
} as const

/** "2026-10-19": the Central date of an instant */
export function centralDay(date: Date): string {
  return formatInTimeZone(date, DEFAULT_TIMEZONE, "yyyy-MM-dd")
}

/** "Mon 2026-10-19": a Central date with its weekday, as Jack's tools give dates (so the model never works out a weekday) */
export function weekdayDate(date: Date): string {
  return formatInTimeZone(date, DEFAULT_TIMEZONE, "EEE yyyy-MM-dd")
}

/** A due date (a Central date) as stored: the start of that day in Central time */
export function dueDateValue(day: string): Date {
  return fromZonedTime(`${day}T00:00:00`, DEFAULT_TIMEZONE)
}

/** Open and due before today (Central). An item due today isn't overdue yet */
export function isOverdue(item: { status: string; dueAt: Date | null }, now: Date): boolean {
  return item.status === "open" && item.dueAt !== null && centralDay(item.dueAt) < centralDay(now)
}

/** Whole days an open item is past its due date (0 when it isn't) */
export function daysOverdue(item: { status: string; dueAt: Date | null }, now: Date): number {
  if (!isOverdue(item, now)) return 0
  const [y1, m1, d1] = centralDay(item.dueAt!).split("-").map(Number)
  const [y2, m2, d2] = centralDay(now).split("-").map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}

/**
 * A meeting's time as stored: a Central date, with a time of day ("18:30") when it's known. A meeting
 * recorded without a time is kept at the start of its day, and shown without one (meetingTimeKnown)
 */
export function meetingTimeValue(day: string, time?: string | null): Date {
  return fromZonedTime(`${day}T${time || "00:00"}:00`, DEFAULT_TIMEZONE)
}

/** False for a meeting kept at the start of its Central day: it was recorded without a time */
export function meetingTimeKnown(heldAt: Date): boolean {
  return formatInTimeZone(heldAt, DEFAULT_TIMEZONE, "HH:mm") !== "00:00"
}

/** "Mon, Oct 19, 2026" or "Mon, Oct 19, 2026, 6:30 PM" (Central) */
export function formatMeetingTime(heldAt: Date): string {
  return formatInTimeZone(heldAt, DEFAULT_TIMEZONE, meetingTimeKnown(heldAt) ? "EEE, MMM d, yyyy, h:mm a" : "EEE, MMM d, yyyy")
}

/** "HH:mm" for a time input, or "" when the meeting was recorded without a time */
export function meetingTimeInput(heldAt: Date): string {
  return meetingTimeKnown(heldAt) ? formatInTimeZone(heldAt, DEFAULT_TIMEZONE, "HH:mm") : ""
}

/** A short title for a decision's knowledge entry, from its text: the first sentence, cut to fit */
export function decisionTitle(text: string, max = MEETING_LIMITS.decisionTitleMax): string {
  const firstLine = text.trim().split(/\n/)[0]
  const sentence = firstLine.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? firstLine
  const clean = sentence.replace(/[.!?]+$/, "").trim()
  if (clean.length < 3) return `Decision: ${clean}`
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trim()}…`
}

/** The decision log entry's text: the decision, then where it was made */
export function decisionBody(text: string, meeting: { title: string; heldAt: Date }): string {
  return `${text.trim()}\n\nDecided at ${meeting.title}, ${formatInTimeZone(meeting.heldAt, DEFAULT_TIMEZONE, "MMM d, yyyy")}.`
}

/** What an agenda copies as: the title, when, and the agenda, as plain text to paste into an email or a chat */
export function agendaText(meeting: { title: string; heldAt: Date; agendaMd: string | null }): string {
  return [meeting.title, formatMeetingTime(meeting.heldAt), "", (meeting.agendaMd ?? "").trim()].join("\n").trim()
}
