"use server"

import { revalidatePath } from "next/cache"
import type { User } from "@prisma/client"
import type { ActionResult } from "@/lib/action-result"
import { dueDateValue, isActionItemStatus } from "@/lib/meetings"
import { requireOfficer } from "@/server/auth/guards"
import { isCalendarDate } from "@/server/jack/tools/time"
import { actionItemPaths, createActionItem, updateActionItem } from "@/server/services/meeting.service"

/**
 * The Action items page's actions (#188), also used on a meeting's page. Any officer adds items, edits
 * them and marks them done, dropped or open again; each checks its own access and goes through the
 * meeting service, which validates and audits.
 */

export type ActionItemFormInput = {
  text: string
  /** An officer's user id, or "" for nobody */
  ownerId: string
  /** YYYY-MM-DD (Central), or "" */
  due: string
}

const SIGNED_OUT = "You're signed out or no longer an officer. Sign in again and retry."

async function officer(): Promise<User | null> {
  try {
    return await requireOfficer()
  } catch {
    return null
  }
}

function revalidate(meetingId?: string | null) {
  for (const path of actionItemPaths(meetingId)) revalidatePath(path)
  revalidatePath("/admin")
}

function toFields(input: Partial<ActionItemFormInput>): { fields: Record<string, unknown> } | { error: string } {
  const fields: Record<string, unknown> = {}
  if (input.text !== undefined) fields.text = input.text
  if (input.ownerId !== undefined) fields.ownerId = input.ownerId || null
  if (input.due !== undefined) {
    const due = input.due.trim()
    if (due && !isCalendarDate(due)) return { error: "The due date isn't a date on the calendar." }
    fields.dueAt = due ? dueDateValue(due) : null
  }
  return { fields }
}

/** Adds an action item, on a meeting when one is given */
export async function addActionItem(input: ActionItemFormInput, meetingId?: string): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const parsed = toFields(input)
  if ("error" in parsed) return { ok: false, error: parsed.error }
  const result = await createActionItem(parsed.fields, { userId: user.id }, { meetingId: meetingId ?? null })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate(result.item.meetingId)
  return { ok: true }
}

/** Changes an item's text, owner or due date (only the fields sent) */
export async function editActionItem(id: string, input: Partial<ActionItemFormInput>): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  const parsed = toFields(input)
  if ("error" in parsed) return { ok: false, error: parsed.error }
  const result = await updateActionItem(id, parsed.fields, { userId: user.id })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate(result.item.meetingId)
  return { ok: true }
}

/** Marks an item done, dropped, or open again */
export async function setActionItemStatus(id: string, status: string): Promise<ActionResult> {
  const user = await officer()
  if (!user) return { ok: false, error: SIGNED_OUT }
  if (!isActionItemStatus(status)) return { ok: false, error: "That isn't a status an action item can have." }
  const result = await updateActionItem(id, { status }, { userId: user.id })
  if (!result.ok) return { ok: false, error: result.error }
  revalidate(result.item.meetingId)
  return { ok: true }
}
