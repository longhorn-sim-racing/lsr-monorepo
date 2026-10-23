import { revalidatePath } from "next/cache"
import { prisma } from "@/server/db"

/** Helpers the discord-post track's proposal kinds share */

export const ANNOUNCEMENTS_PAGE = "/admin/announcements"

/**
 * What officers wrote in the room (their own messages, newest 200): a post's mentions, links and pings
 * are checked against it (design §12.1). Never Jack's replies or room notes
 */
export async function officerTexts(roomId: string): Promise<string[]> {
  const rows = await prisma.jackMessage.findMany({ where: { roomId, kind: "user" }, orderBy: { createdAt: "desc" }, take: 200, select: { content: true } })
  return rows.map((r) => r.content)
}

/** Refreshes the Announcements page after an Apply; outside a request (scripts, DB checks) there's nothing to refresh */
export function refreshAnnouncements(): void {
  try {
    revalidatePath(ANNOUNCEMENTS_PAGE)
    revalidatePath("/admin/discord")
  } catch {}
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`
}

/** "a", "a and b", "a, b and c" */
export function listed(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}
