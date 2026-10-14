import { ROOM_LOCK_STALE_MS } from "@/lib/jack/timing"
import { prisma } from "@/server/db"

/**
 * A room's run lock: one reply loop per room at a time. Each is a single conditional UPDATE, so of
 * several servers trying at once exactly one gets the lock. A lock older than ROOM_LOCK_STALE_MS
 * (6 minutes, longer than a run can live; see lib/jack/timing.ts) is from a run that died, and the
 * next one (a post, or an officer asking Jack to continue) takes it over.
 */
export { ROOM_LOCK_STALE_MS }

/** Takes the lock if it's free or stale. True when this run now holds it */
export async function tryAcquireRoomLock(roomId: string, runId: string, now = new Date()): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - ROOM_LOCK_STALE_MS)
  const { count } = await prisma.jackRoom.updateMany({
    where: { id: roomId, OR: [{ runId: null }, { runStartedAt: null }, { runStartedAt: { lt: staleBefore } }] },
    data: { runId, runStartedAt: now },
  })
  return count === 1
}

/** Restarts the stale clock before each answer. False when the lock went to another run, so this one stops */
export async function renewRoomLock(roomId: string, runId: string, now = new Date()): Promise<boolean> {
  const { count } = await prisma.jackRoom.updateMany({ where: { id: roomId, runId }, data: { runStartedAt: now } })
  return count === 1
}

/** Lets go of the lock, only if this run still holds it */
export async function releaseRoomLock(roomId: string, runId: string): Promise<void> {
  await prisma.jackRoom.updateMany({ where: { id: roomId, runId }, data: { runId: null, runStartedAt: null } })
}

/** Whether a live run holds the room: its lock is taken and not yet stale */
export function isRoomLockHeld(room: { runId: string | null; runStartedAt: Date | null }, now = new Date()): boolean {
  return room.runId !== null && room.runStartedAt !== null && room.runStartedAt.getTime() >= now.getTime() - ROOM_LOCK_STALE_MS
}
