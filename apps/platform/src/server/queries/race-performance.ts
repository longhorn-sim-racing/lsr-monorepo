import type { Prisma } from "@prisma/client"
import { publicEventWhere } from "@/lib/events"
import { publicUserSelect } from "@/lib/public-user"
import { driverKey, trackLabel, type PerfDriver, type RaceData } from "@/lib/race-performance"
import { prisma } from "@/server/db"

/**
 * Loads uploaded race sessions and their results, laps and collisions for the race-performance
 * functions (src/lib/race-performance.ts). Members are selected through publicUserSelect, so what it
 * returns is safe on a public page; `publicOnly` keeps it to sessions of events the public can see.
 */

export type RaceDataScope = {
  /** Only these events' sessions (a season's rounds) */
  eventIds?: string[]
  /** Only sessions of public events (the driver profile) */
  publicOnly?: boolean
  /** Only sessions this member drove in */
  userId?: string
  sessionTypes?: string[]
  since?: Date
  /** Lap rows, for clean laps and consistency (the heaviest part) */
  withLaps?: boolean
  /** Collision events, to split collisions into cars and walls */
  withIncidents?: boolean
  /** The most recent sessions to read */
  maxSessions?: number
}

/** The most sessions one load reads, newest first */
export const MAX_SESSIONS = 400

export async function loadRaceData(scope: RaceDataScope = {}, now = new Date()): Promise<RaceData> {
  const where: Prisma.RaceSessionWhereInput = {
    ...(scope.eventIds ? { eventId: { in: scope.eventIds } } : {}),
    ...(scope.publicOnly ? { event: publicEventWhere(now) } : {}),
    ...(scope.sessionTypes ? { sessionType: { in: scope.sessionTypes } } : {}),
    ...(scope.userId ? { participants: { some: { userId: scope.userId } } } : {}),
    ...(scope.since ? { startedAt: { gte: scope.since } } : {}),
  }
  const rows = await prisma.raceSession.findMany({
    where,
    orderBy: { startedAt: "desc" },
    take: Math.min(scope.maxSessions ?? MAX_SESSIONS, MAX_SESSIONS),
    select: {
      id: true,
      sessionType: true,
      trackName: true,
      trackConfig: true,
      startedAt: true,
      event: { select: { id: true, title: true, slug: true, startsAtUtc: true } },
    },
  })
  const ids = rows.map((s) => s.id)
  if (!ids.length) return { sessions: [], results: [], laps: [], incidents: [] }

  const [results, laps, incidents] = await Promise.all([
    prisma.raceResult.findMany({
      where: { sessionId: { in: ids } },
      select: {
        sessionId: true,
        participantId: true,
        position: true,
        bestLapTime: true,
        lapsCompleted: true,
        totalCuts: true,
        collisionCount: true,
        isDisqualified: true,
        status: true,
        points: true,
        participant: {
          select: { driverGuid: true, displayName: true, carName: true, carMapping: { select: { displayName: true } }, user: { select: publicUserSelect } },
        },
      },
    }),
    scope.withLaps
      ? prisma.raceLap.findMany({ where: { sessionId: { in: ids } }, select: { sessionId: true, participantId: true, lapNumber: true, lapTime: true, valid: true, cuts: true } })
      : Promise.resolve([]),
    scope.withIncidents
      ? prisma.raceEvent.groupBy({ by: ["sessionId", "participantId", "type"], where: { sessionId: { in: ids }, participantId: { not: null } }, _count: { _all: true } })
      : Promise.resolve([]),
  ])

  return {
    sessions: rows.map((s) => ({
      id: s.id,
      type: s.sessionType,
      track: trackLabel(s.trackName, s.trackConfig),
      startedAt: s.startedAt,
      event: s.event ? { id: s.event.id, title: s.event.title, slug: s.event.slug, startsAt: s.event.startsAtUtc } : null,
    })),
    results: results.map((r) => {
      const user = r.participant.user
      const driver: PerfDriver = {
        key: driverKey(user?.id ?? null, r.participant.driverGuid),
        name: user?.displayName ?? r.participant.displayName,
        handle: user?.handle ?? null,
        userId: user?.id ?? null,
      }
      return {
        sessionId: r.sessionId,
        participantId: r.participantId,
        driver,
        driverGuid: r.participant.driverGuid,
        car: r.participant.carMapping?.displayName ?? r.participant.carName,
        position: r.position,
        bestLapMs: r.bestLapTime,
        laps: r.lapsCompleted,
        cuts: r.totalCuts ?? 0,
        collisions: r.collisionCount ?? 0,
        dsq: r.isDisqualified || r.status === "DSQ",
        points: r.points,
      }
    }),
    laps: laps.map((l) => ({ sessionId: l.sessionId, participantId: l.participantId, lapNumber: l.lapNumber, lapMs: l.lapTime, valid: l.valid, cuts: l.cuts ?? 0 })),
    incidents: incidents.flatMap((i) => (i.participantId ? [{ sessionId: i.sessionId, participantId: i.participantId, type: i.type, count: i._count._all }] : [])),
  }
}
