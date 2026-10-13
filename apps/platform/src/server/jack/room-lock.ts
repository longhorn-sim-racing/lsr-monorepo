import { prisma } from "@/server/db"

/**
 * A room's run lock: one reply loop per room at a time. Each is a single conditional UPDATE, so of
 * several servers trying at once exactly one gets the lock. A lock older than this is from a run
 * that died (a function can't live this long), and the next one takes it over.
 */
export const ROOM_LOCK_STALE_MS = 10 * 60 * 1000

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
