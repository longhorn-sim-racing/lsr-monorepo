import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { roomMessageUrl } from "@/lib/jack/proposals"
import { RECURRING_PAGE } from "@/lib/jack/recurring"
import { formatUsd } from "@/lib/jack/spend"
import { prisma } from "@/server/db"
import { broadcastRoomEvent, type RoomBroadcaster } from "@/server/jack/broadcast"
import { chicagoMonth } from "@/server/jack/spend"
import type { JobContext, JobResult } from "@/server/scheduler/types"
import { officerIdSet } from "@/server/services/officers"
import { answerScheduledNote, defaultRunRoom, RETRY_AFTER_MS, RETRY_WINDOW_MS, retryJobAt, type RunRoom } from "../answer"
import { underWay, withAutomationCap, type AutomationBudget, type AutomationGate } from "../cap"
import { announceAutomationNote, insertAutomationNote, postAutomationNote } from "../notes"
import { pauseRecurringQuestion } from "./service"

/**
 * One run of a recurring question (design §11.1), handed off to /api/admin/jack/run by the dispatcher:
 *
 * 1. Its room archived, or its owner no longer an officer: pause it, with a room note, and stop.
 * 2. Automations over their $10 cap (or Jack over his monthly budget), counting the runs under way: skip,
 *    with a room note (once a month), and stop.
 * 3. Post the question as a scheduled note, answered as its owner: "Recurring question “Weekly signups”
 *    (set up by Gray): …". The cap check and this note go together under the cap's lock (cap.ts), so
 *    questions due in the same minute can't all pass a cap only some of them fit under.
 * 4. Run the room. The reply gets a short history (the question and its last answer), no web tools and no
 *    knowledge saves (the reply loop and the tools see a scheduled request). When another run holds the
 *    room, that run answers the note after its current reply; this job looks again in a few minutes.
 *
 * A run that finds its note from an earlier try still waiting (within RETRY_WINDOW_MS) doesn't ask again:
 * it only gets that note answered.
 */

export type RecurringRunDeps = {
  broadcast: RoomBroadcaster
  runRoom: RunRoom
  /** Checks the cap and posts the question under its lock */
  withCap: AutomationGate
  now: () => Date
}

export const defaultRecurringRunDeps: RecurringRunDeps = { broadcast: broadcastRoomEvent, runRoom: defaultRunRoom, withCap: withAutomationCap, now: () => new Date() }

const time = (date: Date) => `${formatInTimeZone(date, DEFAULT_TIMEZONE, "h:mm a")} CT`

/** The note that asks it */
export function askText(question: { title: string; prompt: string }, ownerName: string): string {
  return `Recurring question “${question.title}” (set up by ${ownerName}): ${question.prompt}`
}

/** The start of a note that says a run was skipped for money, so a month gets one */
const SKIPPED = "Skipped the recurring question"

function skippedText(title: string, budget: AutomationBudget): string {
  return budget.stopped === "automation_cap"
    ? `${SKIPPED} “${title}”: automations (recurring questions and digest summaries) have used this month's ${formatUsd(budget.capUsd, { wholeIfRound: true })}${underWay(budget)}. They start again on the 1st → /admin/jack/usage`
    : `${SKIPPED} “${title}”: Jack's monthly budget is used up (${formatUsd(budget.totalUsd)} of ${formatUsd(budget.budgetUsd, { wholeIfRound: true })}). He answers again on the 1st → /admin/jack/usage`
}

export async function runRecurringQuestion(ctx: Pick<JobContext, "job" | "startedAt" | "log">, deps: RecurringRunDeps = defaultRecurringRunDeps): Promise<JobResult> {
  const now = deps.now()
  const question = await prisma.recurringQuestion.findUnique({
    where: { scheduledJobId: ctx.job.id },
    include: { room: { select: { id: true, archivedAt: true } }, createdBy: { select: { id: true, displayName: true } } },
  })
  if (!question) return { status: "skipped", summary: "Its recurring question is gone." }
  const label = `“${question.title}”`
  const note = (content: string, scheduled = false, authorUserId: string | null = null) =>
    postAutomationNote({ roomId: question.roomId, jobKey: ctx.job.key, content, scheduled, authorUserId }, deps.broadcast)

  if (question.room.archivedAt) {
    const paused = await pauseRecurringQuestion(question.id, "its room is archived")
    if (paused) await note(`Paused the recurring question ${label}: this room is archived. Unarchive it, then turn the question back on → ${RECURRING_PAGE}`)
    return { status: "skipped", summary: `${paused ? "Paused" : "Didn't ask"} ${label}: its room is archived.` }
  }

  const ownerId = question.createdById
  const owner = ownerId && (await officerIdSet([ownerId])).has(ownerId) ? question.createdBy : null
  if (!owner) {
    const who = question.createdBy?.displayName ?? "The officer who set it up"
    const reason = question.createdBy ? `${who} isn't an officer any more` : "the officer who set it up deleted their account"
    const paused = await pauseRecurringQuestion(question.id, reason)
    if (paused) await note(`Paused the recurring question ${label}: ${reason}. Another officer can turn it back on and take it over → ${RECURRING_PAGE}`)
    return { status: "skipped", summary: `${paused ? "Paused" : "Didn't ask"} ${label}: ${reason}.` }
  }

  // A note from an earlier try that's still waiting: get it answered rather than ask again
  const [waiting] = await prisma.jackMessage.findMany({
    where: { roomId: question.roomId, jobKey: ctx.job.key, scheduled: true, answeredById: null, createdAt: { gte: new Date(now.getTime() - RETRY_WINDOW_MS) } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { id: true, roomId: true, createdAt: true },
  })
  let asked = waiting ?? null
  if (!asked) {
    const started = await deps.withCap(now, async (budget, db) => ({
      budget,
      note: budget.stopped ? null : await insertAutomationNote({ roomId: question.roomId, jobKey: ctx.job.key, content: askText(question, owner.displayName), scheduled: true, authorUserId: owner.id }, db),
    }))
    const { budget } = started
    if (!started.note) {
      const { start } = chicagoMonth(now)
      const told = await prisma.jackMessage.count({ where: { roomId: question.roomId, jobKey: ctx.job.key, scheduled: false, content: { startsWith: SKIPPED }, createdAt: { gte: start } } })
      if (!told) await note(skippedText(question.title, budget))
      return { status: "skipped", summary: budget.stopped === "automation_cap" ? `Skipped: automations used this month's ${formatUsd(budget.capUsd, { wholeIfRound: true })}${underWay(budget)}.` : "Skipped: Jack's monthly budget is used up." }
    }
    await announceAutomationNote(started.note, deps.broadcast)
    asked = started.note
    await prisma.recurringQuestion.updateMany({ where: { id: question.id }, data: { lastRunAt: now, pausedReason: null } })
  } else {
    ctx.log(`Its question from ${time(asked.createdAt)} was still waiting.`)
  }

  const outcome = await answerScheduledNote(asked, ctx.startedAt, deps.runRoom)
  if (outcome.answer) {
    const cost = outcome.answer.costUsd !== null && outcome.answer.status !== "streaming" ? ` (${formatUsd(outcome.answer.costUsd)})` : ""
    return { summary: `Asked ${label}; ${outcome.answer.status === "streaming" ? "Jack is answering" : "answered"}${cost} → ${roomMessageUrl(question.roomId, outcome.answer.id)}` }
  }
  const age = now.getTime() - asked.createdAt.getTime()
  if (age < RETRY_WINDOW_MS) {
    const at = new Date(deps.now().getTime() + RETRY_AFTER_MS)
    const retrying = await retryJobAt(ctx.job.id, at)
    const why = outcome.busy ? "the room is busy with another answer" : "it didn't get an answer yet"
    return { summary: `Asked ${label}; ${why}${retrying ? `, so it looks again at ${time(at)}` : ""}.` }
  }
  return { summary: `Asked ${label}; still not answered after ${Math.round(RETRY_WINDOW_MS / 60_000)} minutes, so it waits in the room (Continue there answers it) → ${roomMessageUrl(question.roomId, asked.id)}` }
}
