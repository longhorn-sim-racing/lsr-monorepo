import type { Prisma } from "@prisma/client"
import { ADMIN_ROLES } from "@/lib/roles"
import { prisma } from "@/server/db"

/**
 * Officers as owners of things (sponsor prospects, action items): anyone with the officer or admin role
 * whose account isn't deleted. Shared by the Sponsors, Meetings and Action items pages and Jack's
 * proposals, so "who can own this" is one rule.
 */

type Db = Prisma.TransactionClient | typeof prisma

export type OfficerRef = { id: string; displayName: string; handle: string }

export const OFFICER_WHERE = { status: { not: "deleted" }, roles: { some: { role: { key: { in: ADMIN_ROLES } } } } } satisfies Prisma.UserWhereInput

/** Every officer, by name: the owner pickers */
export function listOfficers(db: Db = prisma): Promise<OfficerRef[]> {
  return db.user.findMany({ where: OFFICER_WHERE, orderBy: { displayName: "asc" }, select: { id: true, displayName: true, handle: true } })
}

/** Which of these user ids are officers */
export async function officerIdSet(ids: (string | null | undefined)[], db: Db = prisma): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (!wanted.length) return new Set()
  const rows = await db.user.findMany({ where: { id: { in: wanted }, ...OFFICER_WHERE }, select: { id: true } })
  return new Set(rows.map((row) => row.id))
}

/** "@Dylan-K " → "dylan-k" */
export function cleanHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase()
}

/** Officers by handle (lowercase, without "@"); handles that aren't an officer's are missing from the map */
export async function officersByHandle(handles: string[], db: Db = prisma): Promise<Map<string, OfficerRef>> {
  const wanted = [...new Set(handles.map(cleanHandle).filter(Boolean))]
  if (!wanted.length) return new Map()
  const rows = await db.user.findMany({ where: { handle: { in: wanted }, ...OFFICER_WHERE }, select: { id: true, displayName: true, handle: true } })
  return new Map(rows.map((row) => [row.handle.toLowerCase(), row]))
}

/** Names for user ids, for display ("Former officer" is the caller's to show for a missing one) */
export async function userNames(ids: (string | null | undefined)[], db: Db = prisma): Promise<Map<string, OfficerRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (!wanted.length) return new Map()
  const rows = await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true, handle: true } })
  return new Map(rows.map((row) => [row.id, row]))
}
