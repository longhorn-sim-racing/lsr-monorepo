import { prisma } from "@/server/db"
import type { JobKind } from "../types"

const DAY_MS = 86_400_000

/** Older than this many days, from now */
const olderThan = (days: number) => new Date(Date.now() - days * DAY_MS)

const deleted = (count: number, what: string, days: number) => (count === 0 ? `Nothing older than ${days} days` : `Deleted ${count} ${what} older than ${days} days`)

/**
 * Scheduled job kinds from the groundwork track (design §6): housekeeping that keeps the scheduler's and
 * the syncs' own tables small. The proposal sweep (G4) and the file cleanup (G5) live in their own slot
 * files. Like every job they ship switched off; an admin turns them on from the Scheduled jobs page.
 */
export const JOBS: JobKind[] = [
  {
    kind: "housekeeping.job-runs",
    label: "Prune job history",
    description: "Deletes Scheduled job runs older than 90 days.",
    defaultSchedule: "10 4 * * *",
    budgetMs: 60_000,
    async run() {
      const { count } = await prisma.scheduledJobRun.deleteMany({ where: { startedAt: { lt: olderThan(90) } } })
      return { summary: deleted(count, "runs", 90), counts: { deleted: count } }
    },
  },
  {
    kind: "housekeeping.cron-history",
    label: "Prune pg_cron history",
    description: "Deletes pg_cron's run log (cron.job_run_details) older than 7 days. pg_cron never cleans it up, and the every-minute tick adds 1,440 rows a day.",
    defaultSchedule: "20 4 * * *",
    budgetMs: 60_000,
    async run() {
      const [found] = await prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('cron.job_run_details') IS NOT NULL AS present`
      if (!found?.present) return { summary: "This database has no pg_cron, so there's nothing to prune", status: "skipped" }
      // Rows still running have no end_time yet; those older than a week never finished
      const count = await prisma.$executeRaw`DELETE FROM cron.job_run_details WHERE coalesce(end_time, start_time) < now() - interval '7 days'`
      return { summary: deleted(count, "run log rows", 7), counts: { deleted: count } }
    },
  },
  {
    kind: "housekeeping.twitch-samples",
    label: "Prune Twitch viewer samples",
    description: "Deletes the per-minute viewer counts of streams older than 180 days. Each stream's peak and average viewers stay.",
    defaultSchedule: "30 4 * * *",
    budgetMs: 60_000,
    async run() {
      const { count } = await prisma.twitchViewerSample.deleteMany({ where: { at: { lt: olderThan(180) } } })
      return { summary: deleted(count, "viewer samples", 180), counts: { deleted: count } }
    },
  },
]
