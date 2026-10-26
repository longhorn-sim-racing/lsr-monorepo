"use server"

import { revalidatePath } from "next/cache"
import type { User } from "@prisma/client"
import type { ActionResult } from "@/lib/action-result"
import { SCHEDULE_EVERY, WEEKDAYS, type DigestSettingsInput, type RecurringSchedule, type ScheduleEvery, type Weekday } from "@/lib/jack/recurring"
import { saveDigestSettings } from "@/server/automation/digest/settings"
import {
  askRecurringQuestionNow,
  createRecurringQuestion,
  deleteRecurringQuestion,
  RECURRING_PATHS,
  setRecurringQuestionOn,
  updateRecurringQuestion,
} from "@/server/automation/recurring/service"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { requireOfficer } from "@/server/auth/guards"

/**
 * The Recurring questions page's actions (#188, design §11 and §13). Any officer sets up, changes,
 * switches, asks now and deletes recurring questions (changing what another officer's asks makes it
 * theirs), and sets up the weekly digest; only an admin changes where the digest posts outside the
 * console. Each checks its own access and goes through the automation services, which validate and audit.
 */

/** The question form, as the page sends it */
export type RecurringFormInput = {
  title: string
  prompt: string
  roomId: string
  persona: string
  every: string
  /** For every "week" */
  days: string[]
  /** For every "month", "1" to "28" */
  dayOfMonth: string
  /** "HH:MM", Central */
  time: string
  /** New questions only: start it on */
  on?: boolean
}

const SIGNED_OUT = "You're signed out or no longer an officer. Sign in again and retry."
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 64

async function officer(): Promise<User | null> {
  try {
    return await requireOfficer()
  } catch {
    return null
  }
}

function revalidate() {
  for (const path of RECURRING_PATHS) revalidatePath(path)
  revalidatePath("/admin")
}

function scheduleOf(input: RecurringFormInput): RecurringSchedule {
  const every = (SCHEDULE_EVERY as readonly string[]).includes(input.every) ? (input.every as ScheduleEvery) : "week"
  return {
    every,
    time: String(input.time ?? ""),
    ...(every === "week" ? { days: (Array.isArray(input.days) ? input.days : []).filter((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d)) } : {}),
    ...(every === "month" ? { dayOfMonth: Number(input.dayOfMonth) } : {}),
  }
}

function fieldsOf(input: RecurringFormInput) {
  return { title: input.title, prompt: input.prompt, roomId: input.roomId, persona: input.persona, schedule: scheduleOf(input) }
}

export async function createRecurringQuestionAction(input: RecurringFormInput): Promise<ActionResult<{ id: string }>> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const result = await createRecurringQuestion(fieldsOf(input), { userId: user.id }, { enabled: input.on === true })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate()
  return { ok: true, data: { id: result.question.id } }
}

/** Changes one. Changing its title, what it asks, its room or who answers makes this officer its owner (it's asked as them) */
export async function updateRecurringQuestionAction(id: string, input: RecurringFormInput): Promise<ActionResult<{ tookOver: boolean }>> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  if (!validId(id)) return { ok: false, error: "That recurring question doesn't exist anymore. Reload the page." }
  const result = await updateRecurringQuestion(id, fieldsOf(input), { userId: user.id })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate()
  return { ok: true, data: { tookOver: result.changed.includes("createdById") } }
}

/** On or off. Turning on a question whose owner isn't an officer any more makes this officer its owner */
export async function setRecurringQuestionOnAction(id: string, on: boolean): Promise<ActionResult<{ tookOver: boolean }>> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  if (!validId(id) || typeof on !== "boolean") return { ok: false, error: "That recurring question doesn't exist anymore. Reload the page." }
  const result = await setRecurringQuestionOn(id, on, { userId: user.id })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate()
  return { ok: true, data: { tookOver: result.changed.includes("createdById") } }
}

export async function deleteRecurringQuestionAction(id: string): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  if (!validId(id)) return { ok: false, error: "That recurring question doesn't exist anymore. Reload the page." }
  const result = await deleteRecurringQuestion(id, { userId: user.id })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate()
  return { ok: true }
}

export async function askRecurringQuestionNowAction(id: string): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  if (!validId(id)) return { ok: false, error: "That recurring question doesn't exist anymore. Reload the page." }
  const result = await askRecurringQuestionNow(id, { userId: user.id })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate()
  return { ok: true }
}

export async function saveDigestSettingsAction(input: DigestSettingsInput): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const session = await getCachedSessionUser()
  const result = await saveDigestSettings(input, { userId: user.id, isAdmin: session.roles.includes("admin") })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate()
  return { ok: true }
}
