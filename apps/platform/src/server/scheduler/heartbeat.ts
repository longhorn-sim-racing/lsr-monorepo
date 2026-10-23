import { redactSecrets } from "@/lib/redact"
import { prisma } from "@/server/db"

/**
 * Is the scheduler alive (design §6)? scheduler.tick() writes SchedulerHeartbeat.lastTickAt every minute
 * whether or not anything is due, so an old value means pg_cron stopped (or was never set up), not that
 * the club is quiet. /api/cron/tick writes lastDispatchAt when a signed tick arrives.
 *
 * The admin pages also read pg_cron's and pg_net's own tables when this database has them: whether the
 * tick job is scheduled, how its last run went, and how the site answered recent calls (a wrong secret
 * shows up there as 401s, a wrong URL as redirects or 404s; nothing else records them).
 */

export const HEARTBEAT_ID = "tick"
/** A tick older than this means the scheduler isn't running */
export const SCHEDULER_STALE_MS = 10 * 60_000
/** The pg_cron job setup creates (scripts/jack-scheduler-setup.ts) */
export const TICK_CRON_JOB = "lsr-scheduler-tick"

/** Records a dispatch; `tick` also counts it as a tick (pnpm jack:tick, which stands in for pg_cron locally) */
export async function recordDispatch(at: Date, { tick = false }: { tick?: boolean } = {}): Promise<void> {
  await prisma.schedulerHeartbeat.upsert({
    where: { id: HEARTBEAT_ID },
    create: { id: HEARTBEAT_ID, lastTickAt: at, lastDispatchAt: at },
    update: tick ? { lastTickAt: at, lastDispatchAt: at } : { lastDispatchAt: at },
  })
}

export type SchedulerHealth = {
  lastTickAt: Date | null
  lastDispatchAt: Date | null
  /** never: no tick yet. ok: a tick within 10 minutes. stale: pg_cron stopped ticking */
  state: "never" | "ok" | "stale"
  /** pg_cron's tick job; null when this database has no pg_cron (or it couldn't be read) */
  cron: { scheduled: false } | { scheduled: true; active: boolean; schedule: string; lastRun: { status: string; message: string | null; at: Date | null } | null } | null
  /** How the site answered pg_net's calls in the last 6 hours (pg_net keeps responses that long); null without pg_net */
  delivery: { ok: number; failed: number; lastFailure: { status: number | null; error: string | null; at: Date } | null } | null
}

export function heartbeatState(lastTickAt: Date | null, now: Date): SchedulerHealth["state"] {
  if (!lastTickAt) return "never"
  return now.getTime() - lastTickAt.getTime() > SCHEDULER_STALE_MS ? "stale" : "ok"
}

export async function getSchedulerHealth(now = new Date()): Promise<SchedulerHealth> {
  const [heartbeat, cron, delivery] = await Promise.all([
    prisma.schedulerHeartbeat.findUnique({ where: { id: HEARTBEAT_ID } }),
    readCronJob().catch((error) => {
      console.error("[scheduler] Couldn't read pg_cron's tick job:", error)
      return null
    }),
    readDelivery().catch((error) => {
      console.error("[scheduler] Couldn't read pg_net's responses:", error)
      return null
    }),
  ])
  return {
    lastTickAt: heartbeat?.lastTickAt ?? null,
    lastDispatchAt: heartbeat?.lastDispatchAt ?? null,
    state: heartbeatState(heartbeat?.lastTickAt ?? null, now),
    cron,
    delivery,
  }
}

async function readCronJob(): Promise<SchedulerHealth["cron"]> {
  const [present] = await prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('cron.job') IS NOT NULL AND to_regclass('cron.job_run_details') IS NOT NULL AS present`
  if (!present?.present) return null
  const rows = await prisma.$queryRaw<{ schedule: string; active: boolean; status: string | null; message: string | null; at: Date | null }[]>`
    SELECT j.schedule, j.active, d.status, d.return_message AS message, coalesce(d.end_time, d.start_time) AS at
    FROM cron.job j
    LEFT JOIN LATERAL (
      SELECT status, return_message, start_time, end_time FROM cron.job_run_details
      WHERE jobid = j.jobid ORDER BY start_time DESC NULLS LAST LIMIT 1
    ) d ON true
    WHERE j.jobname = ${TICK_CRON_JOB}
    LIMIT 1`
  const job = rows[0]
  if (!job) return { scheduled: false }
  return {
    scheduled: true,
    active: job.active,
    schedule: job.schedule,
    lastRun: job.status ? { status: job.status, message: job.message ? redactSecrets(job.message, { maxLength: 300 }) : null, at: job.at } : null,
  }
}

async function readDelivery(): Promise<SchedulerHealth["delivery"]> {
  const [present] = await prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('net._http_response') IS NOT NULL AS present`
  if (!present?.present) return null
  const [counts] = await prisma.$queryRaw<{ ok: number; failed: number }[]>`
    SELECT count(*) FILTER (WHERE status_code BETWEEN 200 AND 299)::int AS ok,
           count(*) FILTER (WHERE status_code IS NULL OR status_code NOT BETWEEN 200 AND 299)::int AS failed
    FROM net._http_response WHERE created > now() - interval '6 hours'`
  const [failure] = await prisma.$queryRaw<{ status: number | null; timedOut: boolean | null; error: string | null; at: Date }[]>`
    SELECT status_code AS status, timed_out AS "timedOut", error_msg AS error, created AS at
    FROM net._http_response
    WHERE created > now() - interval '6 hours' AND (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299)
    ORDER BY created DESC LIMIT 1`
  return {
    ok: counts?.ok ?? 0,
    failed: counts?.failed ?? 0,
    lastFailure: failure
      ? { status: failure.status, error: failure.error ? redactSecrets(failure.error, { maxLength: 300 }) : failure.timedOut ? "Timed out" : null, at: failure.at }
      : null,
  }
}
