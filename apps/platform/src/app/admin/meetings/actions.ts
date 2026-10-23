"use server"

import { revalidatePath } from "next/cache"
import type { User } from "@prisma/client"
import type { ActionResult } from "@/lib/action-result"
import { isMeetingType, meetingTimeValue } from "@/lib/meetings"
import { requireOfficer } from "@/server/auth/guards"
import { isCalendarDate } from "@/server/jack/tools/time"
import { addDecision, createMeeting, deleteMeeting, meetingPaths, removeDecision, updateMeeting } from "@/server/services/meeting.service"

/**
 * The Meetings page's actions (#188). Any officer records, edits and deletes meetings and adds or
 * removes decisions; each checks its own access and goes through the meeting service, which validates
 * and audits. A decision also goes to the decision log in Knowledge.
 */

/** The meeting form as the page sends it (an edit sends only what the officer changed; date and time go together) */
export type MeetingFormInput = {
  title: string
  type: string
  /** YYYY-MM-DD (Central) */
  date: string
  /** HH:MM (Central), or "" for no time */
  time: string
  agendaMd: string
  summaryMd: string
}

export type SaveMeetingResult = { ok: true; id: string } | { ok: false; error: string }

const SIGNED_OUT = "You're signed out or no longer an officer. Copy your text, sign in again, and retry."
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

async function officer(): Promise<User | null> {
  try {
    return await requireOfficer()
  } catch {
    return null
  }
}

function revalidate(id?: string) {
  for (const path of meetingPaths(id)) revalidatePath(path)
}

/** The form's fields as the service takes them, only the ones sent */
function toFields(input: Partial<MeetingFormInput>): { fields: Record<string, unknown> } | { error: string } {
  const fields: Record<string, unknown> = {}
  if (input.title !== undefined) fields.title = input.title
  if (input.type !== undefined) {
    if (!isMeetingType(input.type)) return { error: "Pick the meeting's type." }
    fields.type = input.type
  }
  if (input.date !== undefined || input.time !== undefined) {
    const date = input.date?.trim() ?? ""
    const time = input.time?.trim() ?? ""
    if (!isCalendarDate(date)) return { error: "Give the date it's held." }
    if (time && !TIME.test(time)) return { error: "The time should look like 18:30." }
    fields.heldAt = meetingTimeValue(date, time || null)
  }
  if (input.agendaMd !== undefined) fields.agendaMd = input.agendaMd
  if (input.summaryMd !== undefined) fields.summaryMd = input.summaryMd
  return { fields }
}

export async function saveMeeting(id: string | null, input: Partial<MeetingFormInput>): Promise<SaveMeetingResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const parsed = toFields(input)
  if ("error" in parsed) return { ok: false, error: parsed.error }
  try {
    const result = id ? await updateMeeting(id, parsed.fields, { userId: user.id }) : await createMeeting(parsed.fields, { userId: user.id })
    if (!result.ok) return { ok: false, error: result.error }
    revalidate(result.meeting.id)
    return { ok: true, id: result.meeting.id }
  } catch (error) {
    console.error("[meetings] Couldn't save a meeting:", error)
    return { ok: false, error: "Couldn't save the meeting. Your text is still here; try again." }
  }
}

/** Deletes a meeting and its decisions (their decision-log entries and its action items stay) */
export async function removeMeeting(id: string): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const result = await deleteMeeting(id, { userId: user.id })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate()
  revalidatePath(`/admin/meetings/${id}`)
  return { ok: true }
}

/** Adds a decision to a meeting, and to the decision log. Says when the log entry couldn't be written */
export async function addMeetingDecision(meetingId: string, input: { text: string; title: string }): Promise<ActionResult<{ logged: boolean; note?: string }>> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  try {
    const result = await addDecision(meetingId, { text: input.text, title: input.title }, { userId: user.id })
    if (!result.ok) return { ok: false, error: result.error }
    revalidate(meetingId)
    revalidatePath("/admin/knowledge")
    return { ok: true, data: result.knowledge.ok ? { logged: true } : { logged: false, note: result.knowledge.error } }
  } catch (error) {
    console.error("[meetings] Couldn't add a decision:", error)
    return { ok: false, error: "Couldn't add the decision. Try again." }
  }
}

export async function removeMeetingDecision(decisionId: string): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const result = await removeDecision(decisionId, { userId: user.id })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate(result.meetingId ?? undefined)
  return { ok: true }
}
