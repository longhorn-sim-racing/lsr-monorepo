"use server"

import { revalidatePath } from "next/cache"
import type { User } from "@prisma/client"
import type { ActionResult } from "@/lib/action-result"
import { ACTIVITY_TYPES, isProspectStage, type ActivityType } from "@/lib/sponsor-prospects"
import { requireOfficer } from "@/server/auth/guards"
import { centralDate, isCalendarDate, startOfCentralDay } from "@/server/jack/tools/time"
import { createProspect, deleteProspect, deleteProspectActivity, logProspectActivity, prospectPaths, updateProspect } from "@/server/services/sponsor.service"

/**
 * The Sponsors page's actions (#188). Any officer adds, edits and deletes prospects and logs activity;
 * each checks its own access and goes through the sponsor service, which validates and audits.
 */

/** The prospect form as the page sends it: text as typed (an edit sends only the fields the officer changed) */
export type ProspectFormInput = {
  company: string
  website: string
  contactName: string
  contactEmail: string
  contactRole: string
  stage: string
  /** A tier id, or "" for none */
  tierInterest: string
  /** An officer's user id, or "" for none */
  ownerId: string
  nextStep: string
  /** YYYY-MM-DD (Central), or "" */
  nextStepDue: string
  notes: string
}

export type SaveProspectResult = { ok: true; id: string } | { ok: false; error: string; duplicateId?: string }

export type ActivityFormInput = {
  type: string
  summary: string
  /** YYYY-MM-DD (Central) */
  date: string
  /** A stage to move to, or "" to keep it */
  stage: string
}

const SIGNED_OUT = "You're signed out or no longer an officer. Copy your text, sign in again, and retry."

async function officer(): Promise<User | null> {
  try {
    return await requireOfficer()
  } catch {
    return null
  }
}

function revalidate(id?: string) {
  for (const path of prospectPaths(id)) revalidatePath(path)
}

/** The form's fields as the service takes them, only the ones sent ("" clears a field) */
function toFields(input: Partial<ProspectFormInput>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (key === "nextStepDue") fields.nextStepDue = value.trim() ? startOfCentralDay(value.trim()) : null
    else fields[key] = value
  }
  return fields
}

/** Adds a prospect, or edits one (only the fields the officer changed, so a save can't undo someone else's change to the rest) */
export async function saveProspect(id: string | null, input: Partial<ProspectFormInput>): Promise<SaveProspectResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const due = input.nextStepDue?.trim()
  if (due && !isCalendarDate(due)) return { ok: false, error: "The next step's due date isn't a date on the calendar." }
  if (input.stage !== undefined && !isProspectStage(input.stage)) return { ok: false, error: "Pick a stage." }

  try {
    const actor = { userId: user.id }
    const result = id ? await updateProspect(id, toFields(input), actor) : await createProspect(toFields(input), actor)
    if (!result.ok) return { ok: false, error: result.reason === "duplicate" ? `${result.error} Open it instead of adding it again.` : result.error, ...(result.duplicateId ? { duplicateId: result.duplicateId } : {}) }
    revalidate(result.prospect.id)
    return { ok: true, id: result.prospect.id }
  } catch (error) {
    console.error("[sponsors] Couldn't save a prospect:", error)
    return { ok: false, error: "Couldn't save the prospect. Your text is still here; try again." }
  }
}

/** Logs what happened with a prospect, optionally moving it to a new stage */
export async function logActivity(prospectId: string, input: ActivityFormInput): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  if (!(ACTIVITY_TYPES as readonly string[]).includes(input.type)) return { ok: false, error: "Pick what kind of activity it was." }
  const date = input.date.trim()
  if (!isCalendarDate(date)) return { ok: false, error: "Give the date it happened." }
  const now = new Date()
  const today = centralDate(now)
  if (date > today) return { ok: false, error: "That date is in the future; log things once they've happened." }
  if (input.stage && !isProspectStage(input.stage)) return { ok: false, error: "Pick a stage, or leave it as it is." }

  // Today: now. An earlier day: noon that day, so it stays on that date
  const occurredAt = date === today ? now : new Date(startOfCentralDay(date).getTime() + 12 * 3_600_000)
  try {
    const result = await logProspectActivity(prospectId, { type: input.type as ActivityType, summary: input.summary, occurredAt }, { userId: user.id }, input.stage && isProspectStage(input.stage) ? { stage: input.stage } : {})
    if (!result.ok) return { ok: false, error: result.error }
    revalidate(prospectId)
    return { ok: true }
  } catch (error) {
    console.error("[sponsors] Couldn't log an activity:", error)
    return { ok: false, error: "Couldn't log it. Try again." }
  }
}

export async function removeActivity(activityId: string): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const result = await deleteProspectActivity(activityId, { userId: user.id })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate(result.prospectId)
  return { ok: true }
}

/** Deletes a prospect and its activity for good */
export async function removeProspect(id: string): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const result = await deleteProspect(id, { userId: user.id })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate()
  return { ok: true }
}
