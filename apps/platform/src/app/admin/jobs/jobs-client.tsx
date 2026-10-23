"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import {
  Badge,
  Button,
  CellStack,
  DataTable,
  DetailList,
  Dialog,
  EmptyState,
  Field,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  RowActions,
  RowMenu,
  SplitLayout,
  SwitchField,
  ToneText,
  type Column,
  type RowMenuItem,
  type Tone,
} from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { changeScheduledJobSchedule, runScheduledJobNow, setScheduledJobEnabled } from "./actions"

export type JobRow = {
  id: string
  key: string
  kind: string
  label: string
  description: string | null
  /** The running code has this kind; unknown ones are skipped by the dispatcher */
  known: boolean
  /** One job per kind (its schedule is changed here) rather than one per feature row */
  singleton: boolean
  handoff: boolean
  budget: string | null
  schedule: string
  scheduleText: string | null
  /** The next three times it would run, formatted */
  upcoming: string[]
  defaultSchedule: string | null
  defaultScheduleText: string | null
  enabled: boolean
  /** A claim holds it right now */
  running: boolean
  nextRun: string
  nextRunAt: string
  nextRunSort: number
  lastRun: string | null
  lastRunAt: string | null
  lastRunSort: number | null
  lastStatus: string | null
  lastError: string | null
}

export type RunRow = {
  id: string
  jobId: string
  jobLabel: string
  /** ok | skipped | error | running | stopped (its function died; marked failed when the job is next claimed) */
  status: string
  started: string
  startedAgo: string
  took: string | null
  summary: string | null
  error: string | null
}

const STATUS: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: "success", label: "OK" },
  skipped: { tone: "neutral", label: "Skipped" },
  error: { tone: "danger", label: "Failed" },
  running: { tone: "info", label: "Running" },
  stopped: { tone: "danger", label: "Didn't finish" },
}

const status = (value: string | null) => (value ? (STATUS[value] ?? { tone: "neutral" as Tone, label: value }) : null)

const jobHref = (id: string) => `/admin/jobs?job=${encodeURIComponent(id)}`

export function JobsClient({ jobs, runs, selectedId, isAdmin, ticking }: { jobs: JobRow[]; runs: RunRow[]; selectedId: string | null; isAdmin: boolean; ticking: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<JobRow | null>(null)
  const selected = jobs.find((job) => job.id === selectedId) ?? null

  function act(id: string, action: () => Promise<void>) {
    setBusyId(id)
    startTransition(async () => {
      try {
        await action()
      } catch (error) {
        toast.error(unexpectedError(error))
      } finally {
        setBusyId(null)
      }
    })
  }

  const toggle = (job: JobRow, enabled: boolean) =>
    act(job.id, async () => {
      const result = await setScheduledJobEnabled(job.id, enabled)
      if (!result.ok) return void toast.error(result.error)
      toast.success(enabled ? `${job.label} is on: next run ${result.data.nextRun}` : `${job.label} is off`)
    })

  const runNow = (job: JobRow) =>
    act(job.id, async () => {
      const result = await runScheduledJobNow(job.id)
      if (!result.ok) return void toast.error(result.error)
      if (result.data.running) toast.info(`${job.label} is running now; it runs again as soon as this run finishes.`)
      else if (ticking) toast.success(`${job.label} runs on the next tick, within a minute.`)
      else toast.warning(`${job.label} is queued, but the scheduler isn't ticking, so it won't run until it does (locally: pnpm jack:tick).`)
    })

  const columns: Column<JobRow>[] = [
    {
      id: "job",
      header: "Job",
      sortValue: (job) => job.label,
      cell: (job) => (
        <div className="flex min-w-0 items-center gap-2">
          <CellStack
            primary={
              <Link href={jobHref(job.id)} scroll={false} className="hover:underline">
                {job.label}
              </Link>
            }
            secondary={<span className="font-mono">{job.key}</span>}
          />
          {!job.known && <Badge tone="warning">Unknown</Badge>}
          {job.running && <Badge tone="info">Running</Badge>}
        </div>
      ),
    },
    {
      id: "schedule",
      header: "Schedule",
      cell: (job) => <CellStack primary={<span className="font-normal">{job.scheduleText ?? job.schedule}</span>} secondary={job.scheduleText ? <span className="font-mono">{job.schedule}</span> : undefined} />,
      hideBelow: "sm",
    },
    {
      id: "next",
      header: "Next run",
      sortValue: (job) => (job.enabled ? job.nextRunSort : null),
      cell: (job) => (job.enabled ? <span title={job.nextRunAt}>{job.nextRun}</span> : <span className="text-admin-subtle">Off</span>),
      hideBelow: "md",
    },
    {
      id: "last",
      header: "Last run",
      sortValue: (job) => job.lastRunSort,
      cell: (job) => {
        const last = status(job.lastStatus)
        if (!job.lastRun || !last) return <span className="text-admin-subtle">Never</span>
        return (
          <span className="flex flex-col" title={job.lastError ?? job.lastRunAt ?? undefined}>
            <ToneText tone={last.tone}>{last.label}</ToneText>
            <span className="text-xs text-admin-subtle">{job.lastRun}</span>
          </span>
        )
      },
    },
    {
      id: "enabled",
      header: "On",
      sortValue: (job) => job.enabled,
      cell: (job) =>
        isAdmin ? (
          <SwitchField
            className="w-fit"
            label={<span className="sr-only">{`Run ${job.label} on its schedule`}</span>}
            checked={job.enabled}
            disabled={pending && busyId === job.id}
            onCheckedChange={(checked) => toggle(job, checked)}
          />
        ) : job.enabled ? (
          <Badge tone="success">On</Badge>
        ) : (
          <Badge>Off</Badge>
        ),
    },
  ]

  const menu = (job: JobRow): RowMenuItem[] => {
    const items: RowMenuItem[] = [{ label: "Show runs", href: jobHref(job.id) }]
    if (!isAdmin) return items
    items.push({ label: "Run now", onSelect: () => runNow(job), disabled: !job.enabled || !job.known })
    if (job.singleton && job.known) items.push({ label: "Change schedule…", onSelect: () => setEditing(job) })
    return items
  }

  return (
    <>
      <SplitLayout
        main={
          <DataTable
            rows={jobs}
            columns={columns}
            getRowId={(job) => job.id}
            search={{ placeholder: "Search jobs", text: (job) => `${job.label} ${job.key} ${job.description ?? ""}` }}
            onRowClick={(job) => router.replace(jobHref(job.id), { scroll: false })}
            selectedId={selectedId ?? undefined}
            noun={{ one: "job", many: "jobs" }}
            minWidth={560}
            empty={<EmptyState title="No jobs yet" description="Jobs appear here once a part of the site registers one." />}
            rowActions={(job) => (
              <RowActions>
                <RowMenu label={`Actions for ${job.label}`} items={menu(job)} />
              </RowActions>
            )}
          />
        }
        side={<RunsPanel job={selected} runs={runs} isAdmin={isAdmin} onRunNow={runNow} onEdit={setEditing} busy={pending && busyId === selected?.id} />}
      />
      {editing && <ScheduleDialog job={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function RunsPanel({ job, runs, isAdmin, onRunNow, onEdit, busy }: { job: JobRow | null; runs: RunRow[]; isAdmin: boolean; onRunNow: (job: JobRow) => void; onEdit: (job: JobRow) => void; busy: boolean }) {
  return (
    <Panel>
      <PanelHeader
        title={job ? job.label : "Recent runs"}
        description={job ? (job.description ?? "This version of the site doesn't know this job, so it's skipped.") : "Every job's latest runs. Pick a job to see its own."}
        actions={
          job ? (
            <>
              {isAdmin && job.known && (
                <Button size="sm" onClick={() => onRunNow(job)} disabled={!job.enabled} pending={busy} title={job.enabled ? undefined : "Turn the job on first"}>
                  Run now
                </Button>
              )}
              <Button size="sm" variant="ghost" asChild>
                <Link href="/admin/jobs" scroll={false}>
                  All runs
                </Link>
              </Button>
            </>
          ) : undefined
        }
      />
      {job && (
        <PanelBody className="border-b border-admin-row">
          <DetailList
            items={[
              {
                label: "Schedule",
                value: (
                  <span className="flex flex-col gap-0.5">
                    <span>
                      {job.scheduleText ?? job.schedule} <span className="font-mono text-xs text-admin-subtle">{job.schedule}</span>
                    </span>
                    {job.upcoming.length > 0 ? (
                      <span className="text-xs text-admin-subtle">Then {job.upcoming.join(", ")}</span>
                    ) : (
                      <ToneText tone="danger">This schedule can&apos;t be read</ToneText>
                    )}
                    {isAdmin && job.singleton && job.known && (
                      <button type="button" className="w-fit text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onEdit(job)}>
                        Change schedule
                      </button>
                    )}
                  </span>
                ),
              },
              { label: "Status", value: job.enabled ? `On · next run ${job.nextRun}` : "Off" },
              ...(job.budget ? [{ label: "Time budget", value: `${job.budget}${job.handoff ? ", in its own function" : ""}` }] : []),
              { label: "Kind", value: <span className="font-mono text-xs">{job.kind}</span> },
              ...(job.lastError ? [{ label: "Last error", value: <span className="whitespace-pre-wrap text-tone-danger-foreground">{job.lastError}</span> }] : []),
            ]}
          />
        </PanelBody>
      )}
      {runs.length === 0 ? (
        <EmptyState title="No runs yet" description={job ? (job.enabled ? `It first runs ${job.nextRun}.` : "It runs once it's switched on.") : "Runs show up here once a job is switched on and comes due."} />
      ) : (
        <ol className="divide-y divide-admin-row">
          {runs.map((run) => {
            const s = status(run.status)!
            return (
              <li key={run.id} className="flex flex-col gap-1 px-4 py-2.5 text-[13px]">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Badge tone={s.tone}>{s.label}</Badge>
                  {!job && <span className="font-semibold">{run.jobLabel}</span>}
                  <span className="text-admin-subtle" title={run.started}>
                    {run.startedAgo}
                    {run.took ? ` · took ${run.took}` : ""}
                  </span>
                </div>
                {run.summary && <p className="whitespace-pre-wrap break-words text-muted-foreground">{run.summary}</p>}
                {run.error && <p className="whitespace-pre-wrap break-words text-tone-danger-foreground">{run.error}</p>}
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}

function ScheduleDialog({ job, onClose }: { job: JobRow; onClose: () => void }) {
  const [value, setValue] = useState(job.schedule)
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  const save = () =>
    startSaving(async () => {
      try {
        const result = await changeScheduledJobSchedule(job.id, value)
        if (!result.ok) return void setError(result.error)
        toast.success(`${job.label}: ${result.data.description ?? result.data.schedule}`)
        onClose()
      } catch (failure) {
        setError(unexpectedError(failure, "Couldn't change the schedule"))
      }
    })

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Schedule for ${job.label}`}
      description="Five-field cron in Central time: minute, hour, day of month, month, day of week."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} pending={saving} disabled={!value.trim()}>
            Save schedule
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <Field label="Schedule" htmlFor="job-schedule" error={error} hint="0 6 * * * is 6 AM every day; */15 * * * * is every 15 minutes; 0 9 * * 1-5 is 9 AM on weekdays.">
          <Input
            id="job-schedule"
            className="font-mono"
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            aria-invalid={!!error || undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        {job.defaultSchedule && job.defaultSchedule !== value.trim() && (
          <p className="text-xs text-admin-subtle">
            Default: {job.defaultScheduleText ?? job.defaultSchedule}{" "}
            <button type="button" className="font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setValue(job.defaultSchedule!)}>
              Use it
            </button>
          </p>
        )}
      </form>
    </Dialog>
  )
}
