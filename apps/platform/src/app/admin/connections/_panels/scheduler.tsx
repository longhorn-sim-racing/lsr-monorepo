import { SchedulerHeartbeat } from "@/app/admin/jobs/_components/scheduler-heartbeat"

/**
 * The scheduler's heartbeat on the Connections page (design §6, §13): whether pg_cron is ticking, the
 * last tick, how many jobs are on and failing, and a link to Scheduled jobs. Connectors' syncs run as
 * scheduled jobs, so a stopped scheduler means stale data here too. It's the Jobs page's panel with its
 * own data; the page renders it through SafeSlot, so a throw here shows a short notice instead.
 */
export async function SchedulerPanel() {
  // Called, not rendered as <SchedulerHeartbeat />, so its data loads inside SafeSlot's guard
  return await SchedulerHeartbeat({ jobsLink: true })
}
