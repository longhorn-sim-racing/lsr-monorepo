"use server"

import { prisma } from "@/server/db"
import { requireOfficer } from "@/server/auth/guards"

export type AdminUserOption = {
  id: string
  displayName: string
  handle: string
  email: string
  avatarUrl: string | null
  eid: string | null
}

/**
 * Member search for admin pickers: matches name, handle or email, or an exact UT EID. Officers only; the
 * results include emails and EIDs, so never use this on a public page.
 */
export async function searchUsersForAdmin(query: string, options: { activeOnly?: boolean } = {}): Promise<AdminUserOption[]> {
  await requireOfficer()
  const q = query.trim()
  if (q.length < 2) return []
  return prisma.user.findMany({
    where: {
      OR: [
        { displayName: { contains: q, mode: "insensitive" } },
        { handle: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { eid: { equals: q.toLowerCase() } },
      ],
      ...(options.activeOnly ? { status: "active" as const } : {}),
    },
    orderBy: { displayName: "asc" },
    take: 10,
    select: { id: true, displayName: true, handle: true, email: true, avatarUrl: true, eid: true },
  })
}
