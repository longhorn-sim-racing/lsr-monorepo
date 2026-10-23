import type { Prisma, ScheduledJob } from "@prisma/client"
import { z } from "zod"
import { redactSecrets } from "@/lib/redact"
import { signSchedulerRequest } from "@/lib/scheduler-signature"
import { getSiteUrl } from "@/lib/site-url"
import { prisma } from "@/server/db"
import { findJobKind } from "./registry"
import { nextRunAfter } from "./schedule"
import type { JobKind, JobResult } from "./types"

/**
 * The dispatcher (design §6): runs the ScheduledJob rows that are due, from /api/cron/tick (pg_cron) or
 * `pnpm jack:tick`.
 *
 * - A job is claimed with a conditional update (it's still enabled and due, and nobody holds its lock), so
 *   two ticks that overlap, or a replayed one, never run it twice. The claim also sets the next run,
 *   computed from now, so runs missed while the scheduler was down don't pile up.
 * - At most 3 jobs run at once. Claiming stops 200 s into the request, and a job is only claimed when its
 *   budget fits the time the function has left; the rest wait for the next tick.
 * - Kinds this code doesn't know (a newer deploy's, or a removed one's) are skipped: never claimed, never failed.
 * - `handoff` jobs (Jack runs, backfills) get their own invocation: a signed POST to /api/admin/jack/run.
 * - Every run is a ScheduledJobRun row. A run still "running" when its job is next claimed was cut off
 *   with its function and is marked failed then. Errors and summaries go through redactSecrets().
 */

/** The longest a tick or hand-off function may run: the routes' maxDuration */
export const FUNCTION_MAX_MS = 300_000
/** No new claims this long after the request started */
export const CLAIM_WINDOW_MS = 200_000
/** Kept free at the end of the function so results get written before it's stopped */
export const END_MARGIN_MS = 10_000
/** How long a claim holds a job: longer than any function lives, so a lock that ran out means its run is gone */
export const LOCK_MS = 360_000
/** Jobs running at once in one dispatch */
export const MAX_CONCURRENT_JOBS = 3
/** The largest budget a kind may have: it must fit in one function with the end margin to spare */
export const MAX_JOB_BUDGET_MS = FUNCTION_MAX_MS - END_MARGIN_MS
/** Where hand-off jobs are sent */
export const HANDOFF_PATH = "/api/admin/jack/run"

/** How long a job that ignores its abort signal is waited for past its deadline before it's recorded as failed */
const OVERRUN_GRACE_MS = 5_000
/** Due jobs looked at per dispatch */
const MAX_DUE_PER_DISPATCH = 50
/** A job whose saved schedule can't be read is tried again this much later (it fails each time until it's fixed) */
const BAD_SCHEDULE_RETRY_MS = 60 * 60_000
const HANDOFF_TIMEOUT_MS = 15_000
const SUMMARY_MAX_CHARS = 4_000
const MAX_LOG_LINES = 50
const MAX_LOG_LINE_CHARS = 500

export const RUN_RUNNING = "running"
export const ORPHANED_RUN_ERROR = "Didn't finish: its function stopped before the job returned (a timeout or a crash)."

/** What a run is recorded as */
export type RunStatus = "ok" | "skipped" | "error"

/** A job this process holds: its lock (also the hand-off's one-time token) and its open run row */
export type Claim = {
  runId: string
  lockedUntil: Date
  /** When the run started (the claim) */
  startedAt: Date
}

export type DispatchOptions = {
  /** Epoch ms when the request started; deadlines count from it. Default now */
  startedAt?: number
  /** "post" (default) sends handoff jobs to /api/admin/jack/run; "inline" runs them here (pnpm jack:tick, where no server may be running) */
  handoff?: "post" | "inline"
  /** The site the hand-off POST goes to: this deployment's origin. Default getSiteUrl() */
  baseUrl?: string
  fetch?: typeof fetch
  /** Epoch ms; for tests */
  clock?: () => number
}

export type DispatchResult = {
  /** Due jobs found */
  due: number
  /** Claimed and run here, or handed off */
  started: { key: string; status: RunStatus | "handed_off" }[]
  /** Kinds this code doesn't know: left alone */
  unknown: string[]
  /** Left for the next tick: claiming had stopped, or the job's budget didn't fit the time left */
  deferred: string[]
  /** Claimed by another tick first */
  lost: string[]
}

type DueJob = Pick<ScheduledJob, "id" | "key" | "kind" | "schedule" | "config">

type Outcome = {
  status: RunStatus
  summary?: string
  error?: string
  /** The job may still be running in this function: keep its lock until it runs out, so no other tick starts it meanwhile */
  keepLock?: boolean
}

const DUE_SELECT = { id: true, key: true, kind: true, schedule: true, config: true } satisfies Prisma.ScheduledJobSelect

/** Enabled, due, and not held by a live claim */
function dueWhere(now: Date): Prisma.ScheduledJobWhereInput {
  return { enabled: true, nextRunAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }
}

/** How many jobs are due now (the tick route answers with this count) */
export function countDueJobs(now = new Date()): Promise<number> {
  return prisma.scheduledJob.count({ where: dueWhere(now) })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error)
}

/**
 * Claims a due job for one run: a conditional update that only one caller can win. Sets its next run
 * (from now) and its lock, marks runs a dead function left "running" as failed, and opens the run row.
 * Null when another tick got it first, or it stopped being due. `force` claims it due or not and on or
 * off (still never while another claim holds it).
 */
export async function claimJob(job: Pick<ScheduledJob, "id" | "schedule">, nowMs: number, { force = false }: { force?: boolean } = {}): Promise<(Claim & { scheduleError?: string }) | null> {
  const at = new Date(nowMs)
  let nextRunAt: Date
  let scheduleError: string | undefined
  try {
    nextRunAt = nextRunAfter(job.schedule, at)
  } catch (error) {
    scheduleError = `Its schedule "${job.schedule}" can't be read (${errorText(error)}); fix it on the Scheduled jobs page.`
    nextRunAt = new Date(nowMs + BAD_SCHEDULE_RETRY_MS)
  }
  const lockedUntil = new Date(nowMs + LOCK_MS)
  const where: Prisma.ScheduledJobWhereInput = force ? { id: job.id, OR: [{ lockedUntil: null }, { lockedUntil: { lt: at } }] } : { id: job.id, ...dueWhere(at) }
  const { count } = await prisma.scheduledJob.updateMany({ where, data: { lockedUntil, nextRunAt } })
  if (count === 0) return null
  // The lock had run out, so a run still marked running lost its function
  await prisma.scheduledJobRun.updateMany({ where: { jobId: job.id, status: RUN_RUNNING }, data: { status: "error", error: ORPHANED_RUN_ERROR, finishedAt: at } })
  const run = await prisma.scheduledJobRun.create({ data: { jobId: job.id, status: RUN_RUNNING, startedAt: at }, select: { id: true } })
  return { runId: run.id, lockedUntil, startedAt: at, scheduleError }
}

/** Records how a run went and, unless it may still be running, lets go of the job. Only touches the job while this claim still holds it */
export async function finishRun(jobId: string, claim: Claim, outcome: Outcome, clock: () => number = Date.now): Promise<void> {
  const error = outcome.error ? redactSecrets(outcome.error) : null
  const summary = outcome.summary ? redactSecrets(outcome.summary, { maxLength: SUMMARY_MAX_CHARS }) : null
  try {
    await prisma.scheduledJobRun.update({ where: { id: claim.runId }, data: { status: outcome.status, summary, error, finishedAt: new Date(clock()) } })
    await prisma.scheduledJob.updateMany({
      where: { id: jobId, lockedUntil: claim.lockedUntil },
      data: { lastRunAt: claim.startedAt, lastStatus: outcome.status, lastError: error, ...(outcome.keepLock ? {} : { lockedUntil: null }) },
    })
  } catch (failure) {
    console.error(`[scheduler] Couldn't record run ${claim.runId}:`, failure)
  }
}

/** The run's summary: the job's line, its counts, then whatever it logged */
function summarize(result: JobResult | undefined, lines: string[]): string | undefined {
  const counts = Object.entries(result?.counts ?? {})
    .filter(([, n]) => typeof n === "number" && Number.isFinite(n))
    .map(([name, n]) => `${name} ${n}`)
    .join(" · ")
  const text = [typeof result?.summary === "string" ? result.summary : "", counts, ...lines].filter(Boolean).join("\n")
  return text || undefined
}

const OVERRAN = Symbol("overran")

/** Runs a claimed job in this function, with a deadline from the job's budget and the time the function has left */
export async function runJob(job: DueJob, kind: JobKind, { startedAt, clock = Date.now }: { startedAt: number; clock?: () => number }): Promise<Outcome> {
  const begin = clock()
  const deadline = Math.min(begin + kind.budgetMs, startedAt + FUNCTION_MAX_MS - END_MARGIN_MS)
  const controller = new AbortController()
  const reason = deadline < begin + kind.budgetMs ? "Ran out of time: the function running it was about to end" : `Ran out of its ${Math.round(kind.budgetMs / 1000)} s budget`
  const abort = setTimeout(() => controller.abort(new Error(reason)), Math.max(0, deadline - begin))
  let late: ReturnType<typeof setTimeout> | undefined
  const lines: string[] = []
  const log = (line: string) => {
    if (lines.length < MAX_LOG_LINES) lines.push(String(line).slice(0, MAX_LOG_LINE_CHARS))
  }
  try {
    const running = Promise.resolve().then(() =>
      kind.run({ signal: controller.signal, deadline, startedAt, log, config: job.config ?? null, job: { id: job.id, key: job.key } })
    )
    running.catch(() => undefined) // it may reject after the deadline below has already been recorded
    const overran = new Promise<typeof OVERRAN>((resolve) => {
      late = setTimeout(() => resolve(OVERRAN), Math.max(0, deadline + OVERRUN_GRACE_MS - clock()))
    })
    const result = await Promise.race([running, overran])
    if (result === OVERRAN) {
      return {
        status: "error",
        error: `Still running ${Math.round((clock() - begin) / 1000)} s in, past its budget; recorded as failed (it keeps its lock until its function ends).`,
        summary: summarize(undefined, lines),
        keepLock: true,
      }
    }
    return { status: result?.status === "skipped" ? "skipped" : "ok", summary: summarize(result, lines) }
  } catch (error) {
    return { status: "error", error: errorText(error), summary: summarize(undefined, lines) }
  } finally {
    clearTimeout(abort)
    clearTimeout(late)
  }
}

/** The hand-off request body: the job, its open run, and the claim's lock as a one-time token */
const handoffRequest = z.object({
  jobId: z.string().min(1).max(64),
  runId: z.string().min(1).max(64),
  lockedUntil: z.iso.datetime(),
})

export type HandoffRequest = z.infer<typeof handoffRequest>

export function parseHandoffRequest(raw: string): HandoffRequest | null {
  try {
    const parsed = handoffRequest.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Sends a claimed job to /api/admin/jack/run, signed for that route only. On failure the run is recorded as failed and the job let go */
async function handOff(job: DueJob, claim: Claim, options: DispatchOptions, clock: () => number): Promise<boolean> {
  const body = JSON.stringify({ jobId: job.id, runId: claim.runId, lockedUntil: claim.lockedUntil.toISOString() } satisfies HandoffRequest)
  const base = (options.baseUrl ?? getSiteUrl()).replace(/\/+$/, "")
  try {
    const response = await (options.fetch ?? fetch)(`${base}${HANDOFF_PATH}`, {
      method: "POST",
      headers: signSchedulerRequest(body, "run", { nowMs: clock() }),
      body,
      // A redirect would turn the POST into a GET; it's a setup mistake to report, not to follow
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
    })
    if (response.status === 202) return true
    throw new Error(
      response.status >= 300 && response.status < 400
        ? `${HANDOFF_PATH} redirected (${response.status}); the site URL must be the exact canonical one`
        : `${HANDOFF_PATH} answered ${response.status}`
    )
  } catch (error) {
    await finishRun(job.id, claim, { status: "error", error: `Couldn't hand the job off: ${errorText(error)}` }, clock)
    return false
  }
}

/** Runs (or hands off) every due job, within the request's time. Never throws for a job's failure: each one is recorded on its run */
export async function dispatchDueJobs(options: DispatchOptions = {}): Promise<DispatchResult> {
  const clock = options.clock ?? Date.now
  const startedAt = options.startedAt ?? clock()
  const due = await prisma.scheduledJob.findMany({ where: dueWhere(new Date(clock())), orderBy: { nextRunAt: "asc" }, take: MAX_DUE_PER_DISPATCH, select: DUE_SELECT })
  const result: DispatchResult = { due: due.length, started: [], unknown: [], deferred: [], lost: [] }

  const queue: { job: DueJob; kind: JobKind }[] = []
  for (const job of due) {
    const kind = findJobKind(job.kind)
    if (kind) queue.push({ job, kind })
    else result.unknown.push(job.key)
  }

  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { job, kind } = item
      const now = clock()
      const handoff = !!kind.handoff && options.handoff !== "inline"
      const fits = handoff || now + kind.budgetMs <= startedAt + FUNCTION_MAX_MS - END_MARGIN_MS
      if (now - startedAt >= CLAIM_WINDOW_MS || !fits) {
        result.deferred.push(job.key)
        continue
      }
      let claim: Awaited<ReturnType<typeof claimJob>>
      try {
        claim = await claimJob(job, now)
      } catch (error) {
        console.error(`[scheduler] Couldn't claim ${job.key}:`, error)
        result.deferred.push(job.key)
        continue
      }
      if (!claim) {
        result.lost.push(job.key)
        continue
      }
      if (claim.scheduleError) {
        await finishRun(job.id, claim, { status: "error", error: claim.scheduleError }, clock)
        result.started.push({ key: job.key, status: "error" })
      } else if (handoff) {
        result.started.push({ key: job.key, status: (await handOff(job, claim, options, clock)) ? "handed_off" : "error" })
      } else {
        const outcome = await runJob(job, kind, { startedAt, clock })
        await finishRun(job.id, claim, outcome, clock)
        result.started.push({ key: job.key, status: outcome.status })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_JOBS, queue.length) }, worker))
  return result
}

/**
 * Runs one job now in this process, due or not and on or off, hand-off jobs included (pnpm jack:tick --job,
 * so a job can be tried without switching it on in a database other worktrees share). Claimed like any
 * other run, so never while another claim holds it.
 */
export async function runOneJob(key: string, { clock = Date.now }: { clock?: () => number } = {}): Promise<{ ok: true; status: RunStatus; runId: string } | { ok: false; error: string }> {
  const job = await prisma.scheduledJob.findUnique({ where: { key }, select: DUE_SELECT })
  if (!job) return { ok: false, error: `There's no job with the key "${key}"` }
  const kind = findJobKind(job.kind)
  if (!kind) return { ok: false, error: `This code doesn't know the job kind "${job.kind}"` }
  const startedAt = clock()
  const claim = await claimJob(job, startedAt, { force: true })
  if (!claim) return { ok: false, error: "Another run holds it right now" }
  const outcome: Outcome = claim.scheduleError ? { status: "error", error: claim.scheduleError } : await runJob(job, kind, { startedAt, clock })
  await finishRun(job.id, claim, outcome, clock)
  return { ok: true, status: outcome.status, runId: claim.runId }
}

/** A hand-off this route took over: the job is locked to it and its run row is open */
export type AcceptedHandoff = { job: DueJob; kind: JobKind; claim: Claim }

/**
 * /api/admin/jack/run's side of a hand-off. Swaps the dispatcher's lock for its own with a conditional
 * update on the exact lock value, so a hand-off request runs at most once even if it's replayed.
 */
export async function acceptHandoff(request: HandoffRequest, startedAt: number, clock: () => number = Date.now): Promise<{ ok: true; handoff: AcceptedHandoff } | { ok: false; error: string }> {
  const lockedUntil = new Date(startedAt + LOCK_MS)
  const { count } = await prisma.scheduledJob.updateMany({ where: { id: request.jobId, lockedUntil: new Date(request.lockedUntil) }, data: { lockedUntil } })
  if (count === 0) return { ok: false, error: "That job isn't waiting for this hand-off" }

  const [job, run] = await Promise.all([
    prisma.scheduledJob.findUnique({ where: { id: request.jobId }, select: DUE_SELECT }),
    prisma.scheduledJobRun.findFirst({ where: { id: request.runId, jobId: request.jobId, status: RUN_RUNNING }, select: { startedAt: true } }),
  ])
  const claim: Claim = { runId: request.runId, lockedUntil, startedAt: run?.startedAt ?? new Date(startedAt) }
  const kind = job ? findJobKind(job.kind) : undefined
  if (job && run && kind) return { ok: true, handoff: { job, kind, claim } }

  const error = !run ? "Its run isn't open any more" : `This version of the site doesn't know the job kind "${job?.kind}"`
  if (run) await finishRun(request.jobId, claim, { status: "error", error }, clock)
  else await prisma.scheduledJob.updateMany({ where: { id: request.jobId, lockedUntil }, data: { lockedUntil: null } })
  return { ok: false, error }
}

/** Runs a job handed to this invocation, with its own deadline, and records the run */
export async function runHandoff({ job, kind, claim }: AcceptedHandoff, startedAt: number, clock: () => number = Date.now): Promise<RunStatus> {
  const outcome = await runJob(job, kind, { startedAt, clock })
  await finishRun(job.id, claim, outcome, clock)
  return outcome.status
}
