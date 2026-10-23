import { prisma } from "@/server/db"

/** Members the changes track's proposals name: by handle, for notification audiences and check-ins */

export type MemberRef = { id: string; displayName: string; handle: string }

/** A handle as officers write it: "@gray-marshall", "Gray-Marshall" */
export function cleanHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase()
}

/** Members by handle (any case), not deleted accounts; `missing` lists the handles nobody has */
export async function membersByHandle(handles: string[]): Promise<{ found: MemberRef[]; missing: string[] }> {
  const wanted = [...new Set(handles.map(cleanHandle).filter(Boolean))]
  if (!wanted.length) return { found: [], missing: [] }
  const users = await prisma.user.findMany({
    where: { status: { not: "deleted" }, OR: wanted.map((handle) => ({ handle: { equals: handle, mode: "insensitive" as const } })) },
    select: { id: true, displayName: true, handle: true },
  })
  const byHandle = new Map(users.map((user) => [user.handle.toLowerCase(), user]))
  return { found: wanted.flatMap((handle) => byHandle.get(handle) ?? []), missing: wanted.filter((handle) => !byHandle.has(handle)) }
}
