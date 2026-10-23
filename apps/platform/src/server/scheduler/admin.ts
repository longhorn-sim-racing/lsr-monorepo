import { prisma } from "@/server/db"
import { JOB_KINDS } from "./registry"
import { nextRunAfter } from "./schedule"

/**
 * Creates the ScheduledJob row for every registered singleton kind that doesn't have one yet: keyed by
 * the kind, on its default schedule, switched off (an admin turns jobs on). Kinds marked
 * `singleton: false` are left to their feature. Safe to run any time and from several places at once:
 * the Scheduled jobs page and scripts/jack-scheduler-setup.ts both call it. Returns the keys it created.
 */
export async function ensureJobRows(now = new Date()): Promise<string[]> {
  const singletons = JOB_KINDS.filter((kind) => kind.singleton !== false)
  if (singletons.length === 0) return []
  const existing = await prisma.scheduledJob.findMany({ where: { key: { in: singletons.map((kind) => kind.kind) } }, select: { key: true } })
  const have = new Set(existing.map((row) => row.key))
  const missing = singletons.filter((kind) => !have.has(kind.kind))
  if (missing.length === 0) return []
  const { count } = await prisma.scheduledJob.createMany({
    data: missing.map((kind) => ({ key: kind.kind, kind: kind.kind, schedule: kind.defaultSchedule, enabled: false, nextRunAt: nextRunAfter(kind.defaultSchedule, now) })),
    skipDuplicates: true,
  })
  return count > 0 ? missing.map((kind) => kind.kind) : []
}
