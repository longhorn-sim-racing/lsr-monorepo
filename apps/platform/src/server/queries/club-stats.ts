import { EventStatus } from "@prisma/client"
import { prisma } from "@/server/db"
import { publicEventWhere } from "@/lib/events"

export type ClubStats = { members: number; eventsHosted: number }

/** Live member and past-event counts for the stats strips; null if the database can't be reached, so pages still render. */
export async function getClubStats(): Promise<ClubStats | null> {
  const now = new Date()
  try {
    const [members, eventsHosted] = await Promise.all([
      prisma.user.count({ where: { status: "active" } }),
      prisma.event.count({
        where: {
          AND: [
            publicEventWhere(now),
            { startsAtUtc: { lt: now }, status: { notIn: [EventStatus.CANCELLED, EventStatus.POSTPONED] } },
          ],
        },
      }),
    ])
    return { members, eventsHosted }
  } catch (error) {
    console.error("[club-stats] Failed to load stats:", error)
    return null
  }
}
