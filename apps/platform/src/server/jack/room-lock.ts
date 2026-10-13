import { prisma } from "@/server/db"

/**
 * A room's run lock: one reply loop per room at a time. Each is a single conditional UPDATE, so of
 * several servers trying at once exactly one gets the lock. A lock older than this is from a run that
 * died, and the next one (a post, or an officer asking Jack to continue) takes it over.
 *
 * It has to be longer than a run can live: the room page's function stops at maxDuration (300 s), a
 * run cancels whatever it's doing 280 s in (RUN_TIMING in reply-loop.ts), and it renews the lock
 * before each answer, so a live run's lock is never older than about 300 s. Six minutes leaves a
 * margin and keeps a dead run's room stuck no longer than that.
 */
export const ROOM_LOCK_STALE_MS = 6 * 60 * 1000

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
