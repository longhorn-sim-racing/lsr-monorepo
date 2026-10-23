import Link from "next/link"
import { Badge, Button, DetailList, Notice, Panel, PanelBody, PanelHeader, ToneText, type Tone } from "@/components/admin/kit"
import { prisma } from "@/server/db"
import { getSchedulerHealth, type SchedulerHealth } from "@/server/scheduler/heartbeat"
import { describeSchedule } from "@/server/scheduler/schedule"
import { relative, when } from "./format"

/**
 * Whether the scheduler is alive: the last tick from pg_cron, pg_cron's own view of its tick job, and how
 * the site answered pg_net lately. On the Scheduled jobs page, and ready for the Connections page's
 * scheduler slot (render <SchedulerHeartbeat jobsLink />, which loads its own data).
 */
export function SchedulerHeartbeatPanel({
  health,
  enabledJobs,
  now,
  jobsLink = false,
  className,
}: {
  health: SchedulerHealth
  enabledJobs: number
  now: Date
  /** Adds a link to the Scheduled jobs page, for other pages */
  jobsLink?: boolean
  className?: string
}) {
  const badge: { tone: Tone; label: string } =
    health.state === "ok"
      ? { tone: "success", label: "Ticking" }
      : health.state === "stale"
        ? { tone: enabledJobs > 0 ? "danger" : "warning", label: "Not ticking" }
        : { tone: "neutral", label: "Not set up" }

  const items = [
    {
      label: "Last tick",
      value: health.lastTickAt ? (
        <span title={when(health.lastTickAt) ?? undefined}>
          {relative(health.lastTickAt, now)}
          <span className="text-admin-subtle"> · {when(health.lastTickAt)}</span>
        </span>
      ) : (
        <span className="text-admin-subtle">Never</span>
      ),
    },
    {
      label: "Last dispatch",
      value: health.lastDispatchAt ? relative(health.lastDispatchAt, now) : <span className="text-admin-subtle">Never (the site is only called when a job is due)</span>,
    },
  ]
  if (health.cron) items.push({ label: "pg_cron", value: <CronLine cron={health.cron} /> })
  // pg_net keeps no request URLs, so this is every pg_net call; the tick is its only caller here
  if (health.delivery) items.push({ label: "pg_net calls (6 h)", value: <DeliveryLine delivery={health.delivery} now={now} /> })

  return (
    <Panel className={className}>
      <PanelHeader
        title="Scheduler"
        description="pg_cron ticks every minute and calls the site when a job is due. Times are Central."
        actions={
          <>
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {jobsLink && (
              <Button size="sm" variant="ghost" asChild>
                <Link href="/admin/jobs">Scheduled jobs</Link>
              </Button>
            )}
          </>
        }
      />
      <PanelBody className="flex flex-col gap-3">
        {health.state === "stale" && enabledJobs > 0 && (
          <Notice tone="danger" title="The scheduler stopped ticking">
            No job runs until it&apos;s back. Check that the lsr-scheduler-tick job is active in Supabase (Integrations → Cron); a restart of the database brings pg_cron back if it died.
          </Notice>
        )}
        {health.state === "never" && (
          <Notice tone="neutral" title="No tick yet on this database">
            In production pg_cron calls the scheduler once it&apos;s set up (scripts/jack-scheduler-setup.ts). Locally there&apos;s no pg_cron schedule: run <code className="font-mono text-xs">pnpm jack:tick</code> to run what&apos;s due.
          </Notice>
        )}
        <DetailList items={items} />
      </PanelBody>
    </Panel>
  )
}

function CronLine({ cron }: { cron: NonNullable<SchedulerHealth["cron"]> }) {
  if (!cron.scheduled) return <ToneText tone="warning">The tick job isn&apos;t scheduled (see scripts/jack-scheduler-setup.ts)</ToneText>
  const schedule = describeSchedule(cron.schedule) ?? cron.schedule
  const last = cron.lastRun
  return (
    <span className="flex flex-wrap items-center gap-x-1.5">
      <span>
        lsr-scheduler-tick, {schedule.toLowerCase()}
        {!cron.active && <ToneText tone="danger"> (paused)</ToneText>}
      </span>
      {last && (
        <span className="text-admin-subtle">
          · last run <ToneText tone={last.status === "succeeded" ? "success" : last.status === "failed" ? "danger" : "neutral"}>{last.status}</ToneText>
          {last.status === "failed" && last.message ? `: ${last.message}` : ""}
        </span>
      )}
    </span>
  )
}

function DeliveryLine({ delivery, now }: { delivery: NonNullable<SchedulerHealth["delivery"]>; now: Date }) {
  if (delivery.ok + delivery.failed === 0) return <span className="text-admin-subtle">No calls (nothing was due)</span>
  const failure = delivery.lastFailure
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        {delivery.ok} answered{delivery.failed > 0 && <ToneText tone="danger">, {delivery.failed} failed</ToneText>}
      </span>
      {failure && (
        <span className="text-xs text-admin-subtle">
          Last failure {relative(failure.at, now)}: {failure.status ? `HTTP ${failure.status}` : "no answer"}
          {failure.error ? ` (${failure.error})` : ""}
          {failure.status === 401 ? ". A 401 from the tick means the Vault secret and SCHEDULER_SIGNING_SECRET don't match" : ""}
          {failure.status === 405 || (failure.status && failure.status >= 300 && failure.status < 400)
            ? ". A redirect (which turns pg_net's POST into a GET, answered 405) means lsr_scheduler_url isn't the exact canonical address"
            : ""}
        </span>
      )}
    </span>
  )
}

/** The panel with its own data, for pages that don't load the scheduler's health themselves (Connections) */
export async function SchedulerHeartbeat({ jobsLink = false, className }: { jobsLink?: boolean; className?: string } = {}) {
  const now = new Date()
  const [health, enabledJobs] = await Promise.all([getSchedulerHealth(now), prisma.scheduledJob.count({ where: { enabled: true } })])
  return <SchedulerHeartbeatPanel health={health} enabledJobs={enabledJobs} now={now} jobsLink={jobsLink} className={className} />
}
