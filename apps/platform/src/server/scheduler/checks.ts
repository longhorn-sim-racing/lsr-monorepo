import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import type { DigestCheck } from "@/server/automation/types"
import { prisma } from "@/server/db"
import { HEARTBEAT_ID, heartbeatState } from "./heartbeat"

/**
 * The scheduler's "needs attention" checks (design §11.2: failing jobs), for the digest and the Overview.
 * Items name the job and link to it; they never carry its error text, which can quote an outside service.
 */

const MAX_ITEMS = 5
const when = (date: Date) => `${formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, h:mm a")} CT`

/** Jobs are switched on but pg_cron hasn't ticked in 10 minutes (or ever), so none of them runs */
export const schedulerStalled: DigestCheck = {
  id: "scheduler.stalled",
  label: "Scheduler not ticking",
  href: "/admin/jobs",
  order: 90,
  async run({ now }) {
    const [enabled, heartbeat] = await Promise.all([prisma.scheduledJob.count({ where: { enabled: true } }), prisma.schedulerHeartbeat.findUnique({ where: { id: HEARTBEAT_ID } })])
    const state = heartbeatState(heartbeat?.lastTickAt ?? null, now)
    if (enabled === 0 || state === "ok") return { count: 0, severity: "info", items: [] }
    return {
      count: 1,
      severity: "danger",
      items: [
        {
          title: `${enabled} scheduled ${enabled === 1 ? "job is" : "jobs are"} on, but the scheduler isn't ticking`,
          href: "/admin/jobs",
          detail: heartbeat ? `Last tick ${when(heartbeat.lastTickAt)}` : "It has never ticked",
        },
      ],
    }
  },
}

/** Switched-on jobs whose last run failed */
export const jobsFailing: DigestCheck = {
  id: "jobs.failing",
  label: "Failing scheduled jobs",
  href: "/admin/jobs",
  order: 91,
  async run() {
    // Loaded when it runs, not with this module: the digest job's slot file imports the digest checks, and
    // a static import of the job registry here would make that a cycle
    const { findJobKind } = await import("./registry")
    const failing = await prisma.scheduledJob.findMany({
      where: { enabled: true, lastStatus: "error" },
      orderBy: { lastRunAt: "desc" },
      select: { id: true, key: true, kind: true, lastRunAt: true },
    })
    return {
      count: failing.length,
      severity: failing.length ? "warning" : "info",
      items: failing.slice(0, MAX_ITEMS).map((job) => ({
        title: `${findJobKind(job.kind)?.label ?? job.key} failed`,
        href: `/admin/jobs?job=${encodeURIComponent(job.id)}`,
        detail: job.lastRunAt ? `Last run ${when(job.lastRunAt)}` : undefined,
      })),
    }
  },
}
