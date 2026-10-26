import type { ScheduledJobRun } from "@prisma/client"
import { roomMessageUrl } from "@/lib/jack/proposals"
import { isRecurringPersona, recurringJobKey, scheduleFromCron, type RecurringPersona, type RecurringSchedule } from "@/lib/jack/recurring"
import { jackRoomTitle } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { EVAL_ROOM_PREFIX } from "@/server/jack/eval-support"
import { chicagoMonth } from "@/server/jack/spend"
import { describeSchedule } from "@/server/scheduler/schedule"
import { officerIdSet } from "@/server/services/officers"
import { estimateMonthly, type MonthlyEstimate } from "./estimate"

/**
 * What the Recurring questions page shows (#188, design §13): each question with its schedule, owner,
 * state, estimated monthly cost, what it cost this month, and its last runs, each with the reply it got.
 * A run is matched to its note by time (its job's notes carry its key, and a job's runs never overlap:
 * each one holds the job's lock).
 */

/** Runs shown per question */
export const RUNS_PER_QUESTION = 5

export type RecurringRun = {
  id: string
  startedAt: Date
  /** running | ok | error | skipped */
  status: string
  /** The run log's line (redacted when it was saved), or its error */
  summary: string | null
  /** The reply that answered the question this run asked */
  reply: { href: string; costUsd: number | null; status: string } | null
  /** The note it posted, when nothing has answered it yet */
  waiting: { href: string } | null
}

export type RecurringRow = {
  id: string
  title: string
  prompt: string
  persona: RecurringPersona
  roomId: string
  roomTitle: string
  roomArchived: boolean
  owner: { id: string; name: string; officer: boolean } | null
  schedule: RecurringSchedule | null
  cron: string
  scheduleText: string
  enabled: boolean
  pausedReason: string | null
  nextRunAt: Date | null
  lastRunAt: Date | null
  estimate: MonthlyEstimate
  monthUsd: number
  runs: RecurringRun[]
}

type Note = { id: string; roomId: string; createdAt: Date; answeredBy: { id: string; costUsd: unknown; status: string } | null }

/** The note a run posted: the one of its job's notes made while the run was going */
function noteOf(run: Pick<ScheduledJobRun, "startedAt" | "finishedAt">, notes: Note[], now: Date): Note | null {
  const end = run.finishedAt ?? now
  return notes.find((note) => note.createdAt >= run.startedAt && note.createdAt <= end) ?? null
}

export async function listRecurringQuestions(now = new Date()): Promise<RecurringRow[]> {
  const questions = await prisma.recurringQuestion.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { scheduledJob: true, room: { select: { title: true, archivedAt: true } }, createdBy: { select: { id: true, displayName: true } } },
  })
  if (!questions.length) return []
  const keys = questions.map((q) => recurringJobKey(q.id))
  const { start } = chicagoMonth(now)
  const [history, officers, estimates] = await Promise.all([
    // Per question, so one that runs (or retries) a lot doesn't crowd the others out
    Promise.all(
      questions.map(async (question) => {
        const [runs, notes] = await Promise.all([
          prisma.scheduledJobRun.findMany({
            where: { jobId: question.scheduledJobId },
            orderBy: { startedAt: "desc" },
            take: RUNS_PER_QUESTION,
            select: { id: true, startedAt: true, finishedAt: true, status: true, summary: true, error: true },
          }),
          prisma.jackMessage.findMany({
            where: { jobKey: recurringJobKey(question.id), scheduled: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: RUNS_PER_QUESTION * 2,
            select: { id: true, roomId: true, createdAt: true, answeredBy: { select: { id: true, costUsd: true, status: true } } },
          }),
        ])
        return { runs, notes }
      }),
    ),
    officerIdSet(questions.map((q) => q.createdById)),
    estimateMonthly(questions.map((q) => ({ jobKey: recurringJobKey(q.id), persona: isRecurringPersona(q.persona) ? q.persona : "jack", schedule: scheduleFromCron(q.scheduledJob.schedule) })), now),
  ])
  // This month's cost: every answer its notes got since the 1st (Central)
  const monthNotes = await prisma.jackMessage.findMany({
    where: { jobKey: { in: keys }, scheduled: true, createdAt: { gte: start }, answeredById: { not: null } },
    select: { jobKey: true, answeredBy: { select: { costUsd: true } } },
  })
  const monthCost = new Map<string, number>()
  for (const note of monthNotes) {
    if (note.jobKey && note.answeredBy?.costUsd != null) monthCost.set(note.jobKey, (monthCost.get(note.jobKey) ?? 0) + Number(note.answeredBy.costUsd))
  }

  return questions.map((question, i) => {
    const key = recurringJobKey(question.id)
    const { runs, notes } = history[i]
    const job = question.scheduledJob
    return {
      id: question.id,
      title: question.title,
      prompt: question.prompt,
      persona: isRecurringPersona(question.persona) ? question.persona : "jack",
      roomId: question.roomId,
      roomTitle: jackRoomTitle(question.room),
      roomArchived: Boolean(question.room.archivedAt),
      owner: question.createdBy ? { id: question.createdBy.id, name: question.createdBy.displayName, officer: officers.has(question.createdBy.id) } : null,
      schedule: scheduleFromCron(job.schedule),
      cron: job.schedule,
      scheduleText: describeSchedule(job.schedule) ?? job.schedule,
      enabled: job.enabled,
      pausedReason: question.pausedReason,
      nextRunAt: job.enabled ? job.nextRunAt : null,
      lastRunAt: question.lastRunAt,
      estimate: estimates[i],
      monthUsd: Math.round((monthCost.get(key) ?? 0) * 100) / 100,
      runs: runs.map((run) => {
        const note = noteOf(run, notes, now)
        const reply = note?.answeredBy
        return {
          id: run.id,
          startedAt: run.startedAt,
          status: run.status,
          summary: run.status === "error" ? run.error : (run.summary?.split("\n")[0] ?? null),
          reply: note && reply ? { href: roomMessageUrl(note.roomId, reply.id), costUsd: reply.costUsd === null ? null : Number(reply.costUsd), status: reply.status } : null,
          waiting: note && !reply ? { href: roomMessageUrl(note.roomId, note.id) } : null,
        }
      }),
    }
  })
}

/** Rooms a question or the digest can go to: not archived, newest activity first, not the eval's */
export async function roomChoices(limit = 200): Promise<{ id: string; title: string }[]> {
  const rooms = await prisma.jackRoom.findMany({
    where: { archivedAt: null, NOT: { id: { startsWith: EVAL_ROOM_PREFIX } } },
    orderBy: [{ pinnedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
    take: limit,
    select: { id: true, title: true },
  })
  return rooms.map((room) => ({ id: room.id, title: jackRoomTitle(room) }))
}
