import type { Metadata } from "next"
import { PageHeader, Stat, StatRow } from "@/components/admin/kit"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { requireOfficerPage } from "@/server/auth/guards"
import { prisma } from "@/server/db"
import { ensureJobRows } from "@/server/scheduler/admin"
import { RUN_RUNNING } from "@/server/scheduler/dispatcher"
import { getSchedulerHealth } from "@/server/scheduler/heartbeat"
import { findJobKind } from "@/server/scheduler/registry"
import { describeSchedule, nextRuns } from "@/server/scheduler/schedule"
import { duration, relative, when } from "./_components/format"
import { SchedulerHeartbeatPanel } from "./_components/scheduler-heartbeat"
import { JobsClient, type JobRow, type RunRow } from "./jobs-client"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Scheduled jobs" }

const RUNS_PER_JOB = 25
const RECENT_RUNS = 20

export default async function ScheduledJobsPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  await requireOfficerPage()
  const { job: jobParam } = await searchParams

  // New kinds get their (switched off) row the first time an officer opens the page after a deploy
  await ensureJobRows().catch((error) => console.error("[scheduler] Couldn't create rows for new job kinds:", error))

  const now = new Date()
  const [jobs, health, session, lastDay] = await Promise.all([
    prisma.scheduledJob.findMany({ orderBy: [{ enabled: "desc" }, { key: "asc" }] }),
    getSchedulerHealth(now),
    getCachedSessionUser(),
    prisma.scheduledJobRun.groupBy({ by: ["status"], where: { startedAt: { gte: new Date(now.getTime() - 86_400_000) } }, _count: { _all: true } }),
  ])
  const selected = jobs.find((job) => job.id === jobParam) ?? null
  const runs = await prisma.scheduledJobRun.findMany({
    where: selected ? { jobId: selected.id } : undefined,
    orderBy: { startedAt: "desc" },
    take: selected ? RUNS_PER_JOB : RECENT_RUNS,
    include: { job: { select: { key: true, kind: true, lockedUntil: true } } },
  })

  const isAdmin = session.roles.includes("admin")
  const enabled = jobs.filter((job) => job.enabled)
  const failing = enabled.filter((job) => job.lastStatus === "error").length
  const runsToday = lastDay.reduce((sum, row) => sum + row._count._all, 0)
  const failedToday = lastDay.find((row) => row.status === "error")?._count._all ?? 0
  const next = enabled.filter((job) => findJobKind(job.kind)).sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())[0]

  const rows: JobRow[] = jobs.map((job) => {
    const kind = findJobKind(job.kind)
    let upcoming: string[] = []
    try {
      upcoming = nextRuns(job.schedule, now, 3).map((date) => when(date)!)
    } catch {
      // A schedule that can't be read shows as such; the dispatcher fails its runs until it's fixed
    }
    return {
      id: job.id,
      key: job.key,
      kind: job.kind,
      label: kind?.label ?? job.kind,
      description: kind?.description ?? null,
      known: !!kind,
      singleton: kind?.singleton !== false,
      handoff: !!kind?.handoff,
      budget: kind ? duration(kind.budgetMs) : null,
      schedule: job.schedule,
      scheduleText: describeSchedule(job.schedule),
      upcoming,
      defaultSchedule: kind?.defaultSchedule ?? null,
      defaultScheduleText: kind ? describeSchedule(kind.defaultSchedule) : null,
      enabled: job.enabled,
      running: !!job.lockedUntil && job.lockedUntil > now,
      nextRun: relative(job.nextRunAt, now)!,
      nextRunAt: when(job.nextRunAt)!,
      nextRunSort: job.nextRunAt.getTime(),
      lastRun: relative(job.lastRunAt, now),
      lastRunAt: when(job.lastRunAt),
      lastRunSort: job.lastRunAt?.getTime() ?? null,
      lastStatus: job.lastStatus,
      lastError: job.lastError,
    }
  })

  const runRows: RunRow[] = runs.map((run) => {
    // A run still "running" after its job's lock ran out lost its function; the next claim marks it failed
    const stopped = run.status === RUN_RUNNING && !(run.job.lockedUntil && run.job.lockedUntil > now)
    return {
      id: run.id,
      jobId: run.jobId,
      jobLabel: findJobKind(run.job.kind)?.label ?? run.job.key,
      status: stopped ? "stopped" : run.status,
      started: when(run.startedAt)!,
      startedAgo: relative(run.startedAt, now)!,
      took: run.finishedAt ? duration(run.finishedAt.getTime() - run.startedAt.getTime()) : null,
      summary: run.summary,
      error: run.error,
    }
  })

  return (
    <>
      <PageHeader title="Scheduled jobs" description="Syncs and clean-ups that run on a schedule. Every job ships switched off; an admin turns it on." />
      <SchedulerHeartbeatPanel health={health} enabledJobs={enabled.length} now={now} />
      <StatRow>
        <Stat label="Jobs on" value={`${enabled.length} of ${jobs.length}`} hint={enabled.length === 0 ? "None runs until it's switched on" : undefined} />
        <Stat label="Failing" value={failing} hint={failing ? "Last run failed" : "Every job on is fine"} />
        <Stat label="Runs in 24 h" value={runsToday} hint={failedToday ? `${failedToday} failed` : undefined} />
        <Stat label="Next run" value={next ? relative(next.nextRunAt, now) : "—"} hint={next ? (findJobKind(next.kind)?.label ?? next.key) : undefined} />
      </StatRow>
      <JobsClient jobs={rows} runs={runRows} selectedId={selected?.id ?? null} isAdmin={isAdmin} ticking={health.state === "ok"} />
    </>
  )
}
