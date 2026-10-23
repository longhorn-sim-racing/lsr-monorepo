/**
 * Scheduled jobs (#188, design §6). pg_cron calls /api/cron/tick when a ScheduledJob row is due; the
 * dispatcher (G3) claims due jobs and runs their kind. A kind is registered in `jobs/<track>.ts`;
 * officers turn jobs on and set their schedule on the Scheduled jobs page. The dispatcher skips (never
 * claims, never fails) a job whose kind the running code doesn't know.
 */

/** What a job run gets */
export type JobContext = {
  /** Aborted when the run's budget is used up or its function is about to end: stop and return what's done */
  signal: AbortSignal
  /** Epoch ms by which `run` must have returned */
  deadline: number
  /** Adds a line to this run's summary on the Scheduled jobs page. Never log secrets or personal data */
  log(summary: string): void
  /** ScheduledJob.config as saved (JSON, null when unset); the kind parses it with its own schema */
  config: unknown
  /** The ScheduledJob row: one kind can back several jobs (each recurring question is its own job) */
  job: { id: string; key: string }
}

/** How a run went. A run that fails throws instead; the dispatcher records the error through redactSecrets() */
export type JobResult = {
  /** One line for the run log, e.g. "Synced 3 channels, 41 new messages" */
  summary: string
  /** "skipped" when there was nothing it could do (its connector is off or not configured); default "ok" */
  status?: "ok" | "skipped"
  counts?: Record<string, number>
}

export type JobKind = {
  /** Stable, saved on ScheduledJob.kind: "discord.sync" */
  kind: string
  /** e.g. "Discord sync" */
  label: string
  /** What it does, for the Scheduled jobs page */
  description: string
  /** Five-field cron, read in America/Chicago: "0 6 * * *" is 6 AM Central every day. Officers can change a job's schedule */
  defaultSchedule: string
  /** How long one run may take, in ms. The dispatcher only claims a job whose budget fits the time left in the tick */
  budgetMs: number
  /** Runs in its own invocation (the signed hand-off to /api/admin/jack/run) instead of inside the tick: Jack runs, backfills, anything over about 60 s */
  handoff?: boolean
  run(ctx: JobContext): Promise<JobResult>
}
