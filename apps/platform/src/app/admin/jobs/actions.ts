"use server"

import { formatDistance } from "date-fns"
import { revalidatePath } from "next/cache"
import type { ActionResult } from "@/lib/action-result"
import { createAuditLog } from "@/server/audit/log"
import { requireRole } from "@/server/auth/guards"
import { prisma } from "@/server/db"
import { findJobKind } from "@/server/scheduler/registry"
import { describeSchedule, nextRunAfter, normalizeSchedule, scheduleProblem } from "@/server/scheduler/schedule"

/**
 * The Scheduled jobs page's changes (design §6, §13). Admins only: officers see the page read-only.
 * Each one is audited (entity SCHEDULED_JOB).
 */

const PAGE = "/admin/jobs"
const NOT_ADMIN = "Only admins can change scheduled jobs."
const GONE = "That job doesn't exist any more. Reload the page."
const UNKNOWN = "This version of the site doesn't know this job, so it can't run. It may come from a newer or an older deploy."

async function adminId(): Promise<string | null> {
  try {
    return (await requireRole("admin")).id
  } catch {
    return null
  }
}

const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 64

function jobLabel(job: { kind: string; key: string }): string {
  const label = findJobKind(job.kind)?.label ?? job.kind
  return job.key === job.kind ? label : `${label} (${job.key})`
}

/**
 * Turns a job on or off. Turning it on sets its next run from now, so a job that's been off a while
 * doesn't run straight away (Run now does that).
 */
export async function setScheduledJobEnabled(jobId: string, enabled: boolean): Promise<ActionResult<{ enabled: boolean; nextRun: string }>> {
  const actorId = await adminId()
  if (!actorId) return { ok: false, error: NOT_ADMIN }
  if (!validId(jobId) || typeof enabled !== "boolean") return { ok: false, error: GONE }
  const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } })
  if (!job) return { ok: false, error: GONE }
  if (enabled && !findJobKind(job.kind)) return { ok: false, error: UNKNOWN }

  const now = new Date()
  let nextRunAt = job.nextRunAt
  if (enabled) {
    try {
      nextRunAt = nextRunAfter(job.schedule, now)
    } catch {
      return { ok: false, error: `Its schedule "${job.schedule}" can't be read. Change the schedule first.` }
    }
  }
  const nextRun = formatDistance(nextRunAt, now, { addSuffix: true })
  if (job.enabled === enabled) return { ok: true, data: { enabled, nextRun } }

  await prisma.scheduledJob.update({ where: { id: job.id }, data: { enabled, nextRunAt, updatedById: actorId } })
  await createAuditLog({
    actorUserId: actorId,
    actionType: enabled ? "SCHEDULED_JOB_ENABLED" : "SCHEDULED_JOB_DISABLED",
    entityType: "SCHEDULED_JOB",
    entityId: job.id,
    summary: `${enabled ? "Turned on" : "Turned off"} the scheduled job ${jobLabel(job)}`,
    before: { enabled: job.enabled },
    after: { enabled, nextRunAt },
    metadata: { key: job.key, kind: job.kind },
  })
  revalidatePath(PAGE)
  return { ok: true, data: { enabled, nextRun } }
}

/** Moves an enabled job's next run to now: it runs on the next tick (or right after the run going on now) */
export async function runScheduledJobNow(jobId: string): Promise<ActionResult<{ running: boolean }>> {
  const actorId = await adminId()
  if (!actorId) return { ok: false, error: NOT_ADMIN }
  if (!validId(jobId)) return { ok: false, error: GONE }
  const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } })
  if (!job) return { ok: false, error: GONE }
  if (!findJobKind(job.kind)) return { ok: false, error: UNKNOWN }
  if (!job.enabled) return { ok: false, error: "Turn the job on first: Run now moves an enabled job's next run to now." }

  const now = new Date()
  await prisma.scheduledJob.update({ where: { id: job.id }, data: { nextRunAt: now, updatedById: actorId } })
  await createAuditLog({
    actorUserId: actorId,
    actionType: "SCHEDULED_JOB_RUN_NOW",
    entityType: "SCHEDULED_JOB",
    entityId: job.id,
    summary: `Asked for the scheduled job ${jobLabel(job)} to run now`,
    before: { nextRunAt: job.nextRunAt },
    after: { nextRunAt: now },
    metadata: { key: job.key, kind: job.kind },
  })
  revalidatePath(PAGE)
  return { ok: true, data: { running: !!job.lockedUntil && job.lockedUntil > now } }
}

/** Changes a singleton job's schedule (five-field cron, Central time); its next run is computed from now */
export async function changeScheduledJobSchedule(jobId: string, schedule: string): Promise<ActionResult<{ schedule: string; description: string | null }>> {
  const actorId = await adminId()
  if (!actorId) return { ok: false, error: NOT_ADMIN }
  if (!validId(jobId) || typeof schedule !== "string") return { ok: false, error: GONE }
  const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } })
  if (!job) return { ok: false, error: GONE }
  const kind = findJobKind(job.kind)
  if (!kind) return { ok: false, error: UNKNOWN }
  if (kind.singleton === false) return { ok: false, error: "This job's schedule is set on the page that created it, not here." }

  const problem = scheduleProblem(schedule)
  if (problem) return { ok: false, error: problem }
  const normalized = normalizeSchedule(schedule)
  const description = describeSchedule(normalized)
  if (normalized === job.schedule) return { ok: true, data: { schedule: normalized, description } }

  const nextRunAt = nextRunAfter(normalized, new Date())
  await prisma.scheduledJob.update({ where: { id: job.id }, data: { schedule: normalized, nextRunAt, updatedById: actorId } })
  await createAuditLog({
    actorUserId: actorId,
    actionType: "SCHEDULED_JOB_SCHEDULE_CHANGED",
    entityType: "SCHEDULED_JOB",
    entityId: job.id,
    summary: `Changed the schedule of ${jobLabel(job)} to ${description ?? normalized}`,
    before: { schedule: job.schedule, nextRunAt: job.nextRunAt },
    after: { schedule: normalized, nextRunAt },
    metadata: { key: job.key, kind: job.kind },
  })
  revalidatePath(PAGE)
  return { ok: true, data: { schedule: normalized, description } }
}
