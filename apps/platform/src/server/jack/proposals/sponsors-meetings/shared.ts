import { formatInTimeZone } from "date-fns-tz"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { cleanHandle, officersByHandle, type OfficerRef } from "@/server/services/officers"
import { centralDate, startOfCentralDay } from "../../tools/time"
import { ProposalInputError } from "../errors"

/** Pieces the sponsors-meetings proposal kinds share (#188, design §4.3) */

/** A record id (a uuid; a wrong one is "doesn't exist", so the schema stays short) */
export const idInput = z.string().trim().min(1).max(64)

export const handleInput = z.string().trim().min(1).max(80)

/**
 * Officers by handle, for the handles given (lowercase, without "@"). Throws ProposalInputError naming
 * any that aren't an officer's, so the model can fix them
 */
export async function resolveOfficers(handles: (string | null | undefined)[], what: string): Promise<Map<string, OfficerRef>> {
  const wanted = [...new Set(handles.filter((h): h is string => typeof h === "string" && h.trim().length > 0).map(cleanHandle))]
  const found = await officersByHandle(wanted)
  const missing = wanted.filter((handle) => !found.has(handle))
  if (missing.length) {
    throw new ProposalInputError(
      `${missing.map((h) => `@${h}`).join(", ")} ${missing.length === 1 ? "isn't an officer's handle" : "aren't officers' handles"}. ${what} must be an officer: get handles from club_members, or leave it out.`,
    )
  }
  return found
}

/** The officer for a handle the payload gave (already resolved), or null for none */
export function officerFor(owners: Map<string, OfficerRef>, handle: string | null | undefined): OfficerRef | null {
  return handle ? (owners.get(cleanHandle(handle)) ?? null) : null
}

/** "Mon Oct 26" (Central), for the card */
export function cardDay(date: Date | null | undefined): string | null {
  return date ? formatInTimeZone(date, DEFAULT_TIMEZONE, "EEE MMM d") : null
}

/** "Mon Oct 26, 2026" (Central), for results and the model */
export function longDay(date: Date): string {
  return formatInTimeZone(date, DEFAULT_TIMEZONE, "EEE MMM d, yyyy")
}

/**
 * When something on a Central date happened: now when it's today, else noon that day (so it stays on
 * that date whatever the clock). Throws for a date after today
 */
export function happenedAt(day: string | undefined, now: Date): Date {
  const today = centralDate(now)
  if (!day || day === today) return now
  if (day > today) throw new ProposalInputError(`${day} is after today (${today}); log things once they've happened.`)
  return new Date(startOfCentralDay(day).getTime() + 12 * 3_600_000)
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** "Acme, Bolt and 3 more" */
export function listNames(names: string[], shown = 3): string {
  if (names.length <= shown) return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "")
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`
}

/** Revalidates admin paths after an apply; outside a request (scripts) there's nothing to revalidate */
export function revalidateQuietly(paths: string[]): void {
  try {
    for (const path of new Set(paths)) revalidatePath(path)
  } catch {}
}
