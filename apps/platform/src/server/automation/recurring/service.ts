import { randomUUID } from "node:crypto"
import type { Prisma, RecurringQuestion, ScheduledJob } from "@prisma/client"
import { cronFor, isAtMostDaily, RECURRING_JOB_KIND, RECURRING_PAGE, recurringJobKey, scheduleFromCron } from "@/lib/jack/recurring"
import { RECURRING_FIELD_LABEL, recurringChangesSchema, recurringFieldsSchema, type RecurringChanges } from "@/schemas/recurring-question.schema"
import { createAuditLog } from "@/server/audit/log"
import { prisma } from "@/server/db"
import { nextRunAfter } from "@/server/scheduler/schedule"
import { withActorMetadata, type ServiceActor } from "@/server/services/actor"
import { officerIdSet } from "@/server/services/officers"

/**
 * Recurring questions (#188, design §11.1). The Recurring questions page and Jack's recurring.upsert
 * proposal both write through here.
 *
 * - The schedule lives only on the question's ScheduledJob (key "recurring:<id>", kind
 *   "recurring.question"), created, changed and deleted in the same transaction as the question. Deleting
 *   the question deletes the job (a database trigger), and deleting the job deletes the question.
 * - Schedules come from RecurringSchedule (lib/jack/recurring.ts), so they run at most once a day; a cron
 *   that could run more often is refused all the same.
 * - On and off is the job's `enabled`. A question starts off unless the caller turns it on. When a run
 *   pauses one itself (its owner isn't an officer any more, its room was archived), `pausedReason` says
 *   why; turning it back on clears that.
 * - It runs as `createdById`: whoever set it up, or whoever last changed its title, what it asks, its room
 *   or who answers (the room note, title included, and the reply's tools name them, so they must have
 *   written it). Turning a question back on whose owner isn't an officer any more makes the officer who
 *   turns it on its owner.
 * - With `expected` (a snapshot read earlier) a write locks the rows and refuses (reason "changed") when
 *   the question moved on since, so a stale proposal never overwrites an officer's edit.
 * Callers revalidate (RECURRING_PATHS): revalidatePath only works inside a request.
 */

type Db = Prisma.TransactionClient

export type QuestionWithJob = RecurringQuestion & { scheduledJob: ScheduledJob }

export type RecurringWriteResult =
  | { ok: true; question: QuestionWithJob; changed: string[] }
  | { ok: false; reason: "invalid" | "not_found" | "changed" | "room"; error: string }

/** What a proposal snapshots and compares: the fields a change can touch, the schedule as its cron */
export type RecurringSnapshot = { title: string; prompt: string; roomId: string; persona: string; schedule: string; enabled: boolean }

export const RECURRING_PATHS = [RECURRING_PAGE, "/admin/jobs"]

const GONE = { ok: false, reason: "not_found", error: "That recurring question doesn't exist anymore (it may have been deleted)." } as const

export function snapshotOf(question: QuestionWithJob): RecurringSnapshot {
  return {
    title: question.title,
    prompt: question.prompt,
    roomId: question.roomId,
    persona: question.persona,
    schedule: question.scheduledJob.schedule,
    enabled: question.scheduledJob.enabled,
  }
}

/** Why a question can't be asked in this room (gone, or archived), or null */
export async function roomProblem(db: Db | typeof prisma, roomId: string): Promise<"gone" | "archived" | null> {
  const room = await db.jackRoom.findUnique({ where: { id: roomId }, select: { archivedAt: true } })
  return !room ? "gone" : room.archivedAt ? "archived" : null
}

const ROOM_PROBLEM = {
  gone: "That room doesn't exist (it may have been deleted).",
  archived: "That room is archived. Unarchive it first, or pick another room.",
} as const

function firstIssue(error: { issues: { message: string }[] }, fallback: string): string {
  return error.issues[0]?.message ?? fallback
}

/** The audit entry's view of a question: what it asks, where and when, never more */
function brief(question: { title: string; prompt: string; roomId: string; persona: string }, schedule: string, enabled: boolean) {
  return { title: question.title, prompt: question.prompt, roomId: question.roomId, persona: question.persona, schedule, enabled }
}

/** Sets up a question with its job. Off unless `enabled`; it runs as `createdById` (default: the actor) */
export async function createRecurringQuestionTx(
  tx: Db,
  input: unknown,
  actor: ServiceActor,
  options: { createdById?: string; enabled?: boolean; now?: Date } = {},
): Promise<RecurringWriteResult> {
  const parsed = recurringFieldsSchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", error: firstIssue(parsed.error, "Check the recurring question.") }
  const fields = parsed.data
  const room = await roomProblem(tx, fields.roomId)
  if (room) return { ok: false, reason: "room", error: ROOM_PROBLEM[room] }

  const now = options.now ?? new Date()
  const enabled = options.enabled ?? false
  const schedule = cronFor(fields.schedule)
  const id = randomUUID()
  const job = await tx.scheduledJob.create({
    data: { key: recurringJobKey(id), kind: RECURRING_JOB_KIND, schedule, enabled, nextRunAt: nextRunAfter(schedule, now), createdById: actor.userId, updatedById: actor.userId },
  })
  const question = await tx.recurringQuestion.create({
    data: { id, title: fields.title, prompt: fields.prompt, roomId: fields.roomId, persona: fields.persona, scheduledJobId: job.id, createdById: options.createdById ?? actor.userId },
  })
  await createAuditLog(
    {
      actorUserId: actor.userId,
      actionType: "CREATE",
      entityType: "RECURRING_QUESTION",
      entityId: id,
      summary: `Set up the recurring question “${question.title}”${enabled ? "" : " (off)"}`,
      after: brief(question, schedule, enabled),
      metadata: withActorMetadata(actor, { jobKey: job.key, createdById: question.createdById }),
    },
    tx,
  )
  return { ok: true, question: { ...question, scheduledJob: job }, changed: Object.keys(fields) }
}

export function createRecurringQuestion(input: unknown, actor: ServiceActor, options: { createdById?: string; enabled?: boolean } = {}): Promise<RecurringWriteResult> {
  return prisma.$transaction((tx) => createRecurringQuestionTx(tx, input, actor, options))
}

/** Locks a question and its job for the rest of the transaction and reads them */
async function lockQuestion(tx: Db, id: string): Promise<QuestionWithJob | null> {
  await tx.$queryRaw`SELECT id FROM "RecurringQuestion" WHERE id = ${id} FOR UPDATE`
  const question = await tx.recurringQuestion.findUnique({ where: { id }, include: { scheduledJob: true } })
  if (!question) return null
  await tx.$queryRaw`SELECT id FROM "ScheduledJob" WHERE id = ${question.scheduledJobId} FOR UPDATE`
  return question
}

/** The snapshot fields that moved on since `expected` was read */
function movedFields(current: QuestionWithJob, expected: Partial<RecurringSnapshot> | undefined): string[] {
  const now = snapshotOf(current)
  return Object.entries(expected ?? {})
    .filter(([key, value]) => now[key as keyof RecurringSnapshot] !== value)
    .map(([key]) => key)
}

const changedMessage = (title: string, moved: string[]) => `The recurring question “${title}” changed since this was read (${moved.join(", ")}).`

/**
 * The fields that make a run ask something else, somewhere else, or of someone else: changing one takes the
 * question over. The title too: the note that asks it starts with it, and Jack reads that note as the question
 */
export const TAKES_OVER: readonly string[] = ["title", "prompt", "roomId", "persona"]

/**
 * Changes a question: only the fields given. A new schedule moves its next run (from now, when it's on).
 * A change to its title, what it asks, its room or who answers makes `owner` (default: the actor) its
 * owner, so its runs are asked as, and credited to, the officer who wrote that version, never someone else
 */
export async function updateRecurringQuestionTx(
  tx: Db,
  id: string,
  input: unknown,
  actor: ServiceActor,
  options: { expected?: Partial<RecurringSnapshot>; now?: Date; owner?: string } = {},
): Promise<RecurringWriteResult> {
  const parsed = recurringChangesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", error: firstIssue(parsed.error, "Check the recurring question.") }
  const changes: RecurringChanges = parsed.data
  const current = await lockQuestion(tx, id)
  if (!current) return GONE
  const moved = movedFields(current, options.expected)
  if (moved.length) return { ok: false, reason: "changed", error: changedMessage(current.title, moved) }

  const schedule = changes.schedule ? cronFor(changes.schedule) : undefined
  const changed: string[] = []
  const data: Prisma.RecurringQuestionUpdateInput = {}
  for (const key of ["title", "prompt", "roomId", "persona"] as const) {
    if (changes[key] !== undefined && changes[key] !== current[key]) {
      changed.push(key)
      if (key === "roomId") data.room = { connect: { id: changes.roomId } }
      else data[key] = changes[key]
    }
  }
  if (schedule && schedule !== current.scheduledJob.schedule) changed.push("schedule")
  if (!changed.length) return { ok: true, question: current, changed }
  if (changed.includes("roomId")) {
    const room = await roomProblem(tx, changes.roomId!)
    if (room) return { ok: false, reason: "room", error: ROOM_PROBLEM[room] }
  }
  const owner = options.owner ?? actor.userId
  const tookOver = owner !== current.createdById && changed.some((key) => TAKES_OVER.includes(key))
  if (tookOver) data.createdBy = { connect: { id: owner } }

  const question = Object.keys(data).length ? await tx.recurringQuestion.update({ where: { id }, data }) : current
  const job = changed.includes("schedule")
    ? await tx.scheduledJob.update({
        where: { id: current.scheduledJobId },
        data: { schedule, updatedById: actor.userId, ...(current.scheduledJob.enabled ? { nextRunAt: nextRunAfter(schedule!, options.now ?? new Date()) } : {}) },
      })
    : current.scheduledJob
  await createAuditLog(
    {
      actorUserId: actor.userId,
      actionType: "UPDATE",
      entityType: "RECURRING_QUESTION",
      entityId: id,
      summary: `Changed the recurring question “${question.title}” (${changed.map((key) => RECURRING_FIELD_LABEL[key as keyof typeof RECURRING_FIELD_LABEL].toLowerCase()).join(", ")})${tookOver ? (owner === actor.userId ? " and took it over" : " and handed it to the officer who asked for the change") : ""}`,
      before: { ...brief(current, current.scheduledJob.schedule, current.scheduledJob.enabled), ...(tookOver ? { createdById: current.createdById } : {}) },
      after: { ...brief(question, job.schedule, job.enabled), ...(tookOver ? { createdById: owner } : {}) },
      metadata: withActorMetadata(actor, { changedFields: tookOver ? [...changed, "createdById"] : changed }),
    },
    tx,
  )
  return { ok: true, question: { ...question, scheduledJob: job }, changed: tookOver ? [...changed, "createdById"] : changed }
}

export function updateRecurringQuestion(id: string, input: unknown, actor: ServiceActor): Promise<RecurringWriteResult> {
  return prisma.$transaction((tx) => updateRecurringQuestionTx(tx, id, input, actor))
}

/**
 * Turns a question on or off. On: its next run is from now, a reason it was paused for is cleared, and
 * when its owner isn't an officer any more the actor takes it over (it runs as them from now on). A
 * question in an archived room can't be turned on
 */
export async function setRecurringQuestionOnTx(tx: Db, id: string, on: boolean, actor: ServiceActor, options: { expected?: Partial<RecurringSnapshot>; now?: Date } = {}): Promise<RecurringWriteResult> {
  const current = await lockQuestion(tx, id)
  if (!current) return GONE
  const moved = movedFields(current, options.expected)
  if (moved.length) return { ok: false, reason: "changed", error: changedMessage(current.title, moved) }
  if (current.scheduledJob.enabled === on && (!on || !current.pausedReason)) return { ok: true, question: current, changed: [] }

  let createdById = current.createdById
  if (on) {
    const room = await roomProblem(tx, current.roomId)
    if (room) return { ok: false, reason: "room", error: room === "archived" ? "Its room is archived. Unarchive the room first, or move the question to another room." : ROOM_PROBLEM[room] }
    if (!createdById || !(await officerIdSet([createdById], tx)).has(createdById)) createdById = actor.userId
  }
  const schedule = current.scheduledJob.schedule
  if (on && !isAtMostDaily(schedule)) return { ok: false, reason: "invalid", error: "Its schedule runs more than once a day. Change it first." }
  const job = await tx.scheduledJob.update({
    where: { id: current.scheduledJobId },
    data: { enabled: on, updatedById: actor.userId, ...(on ? { nextRunAt: nextRunAfter(schedule, options.now ?? new Date()) } : {}) },
  })
  const question = await tx.recurringQuestion.update({ where: { id }, data: { pausedReason: null, ...(createdById !== current.createdById ? { createdById } : {}) } })
  const tookOver = createdById !== current.createdById
  await createAuditLog(
    {
      actorUserId: actor.userId,
      actionType: on ? "ENABLE" : "DISABLE",
      entityType: "RECURRING_QUESTION",
      entityId: id,
      summary: `${on ? "Turned on" : "Turned off"} the recurring question “${question.title}”${tookOver ? " and took it over" : ""}`,
      before: { enabled: current.scheduledJob.enabled, pausedReason: current.pausedReason, createdById: current.createdById },
      after: { enabled: on, createdById },
      metadata: withActorMetadata(actor),
    },
    tx,
  )
  return { ok: true, question: { ...question, scheduledJob: job }, changed: ["enabled", ...(tookOver ? ["createdById"] : [])] }
}

export function setRecurringQuestionOn(id: string, on: boolean, actor: ServiceActor): Promise<RecurringWriteResult> {
  return prisma.$transaction((tx) => setRecurringQuestionOnTx(tx, id, on, actor))
}

/**
 * A run pausing its own question (no officer: its owner left the officers, its room was archived). Only
 * while it's still on, so an officer who switched it meanwhile wins. True when it paused it
 */
export async function pauseRecurringQuestion(id: string, reason: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const current = await lockQuestion(tx, id)
    if (!current || !current.scheduledJob.enabled) return false
    await tx.scheduledJob.update({ where: { id: current.scheduledJobId }, data: { enabled: false } })
    await tx.recurringQuestion.update({ where: { id }, data: { pausedReason: reason } })
    await createAuditLog(
      {
        actorUserId: null,
        actionType: "PAUSE",
        entityType: "RECURRING_QUESTION",
        entityId: id,
        summary: `Paused the recurring question “${current.title}”: ${reason}`,
        before: { enabled: true },
        after: { enabled: false, pausedReason: reason },
      },
      tx,
    )
    return true
  })
}

/**
 * Deletes a question; the database deletes its job with it. Its notes and answers stay in the room. In
 * one transaction with its audit entry; a second delete (or its job's) that got there first reads as gone
 */
export async function deleteRecurringQuestion(id: string, actor: ServiceActor): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  return prisma.$transaction(async (tx) => {
    const question = await lockQuestion(tx, id)
    if (!question) return { ok: false, error: GONE.error }
    const { count } = await tx.recurringQuestion.deleteMany({ where: { id } })
    if (!count) return { ok: false, error: GONE.error }
    await createAuditLog(
      {
        actorUserId: actor.userId,
        actionType: "DELETE",
        entityType: "RECURRING_QUESTION",
        entityId: id,
        summary: `Deleted the recurring question “${question.title}”`,
        before: brief(question, question.scheduledJob.schedule, question.scheduledJob.enabled),
        metadata: withActorMetadata(actor, { jobKey: question.scheduledJob.key }),
      },
      tx,
    )
    return { ok: true, title: question.title }
  })
}

/** Asks an on question at the next tick (its next run moves to now) */
export async function askRecurringQuestionNow(id: string, actor: ServiceActor, now = new Date()): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  const question = await prisma.recurringQuestion.findUnique({ where: { id }, include: { scheduledJob: true } })
  if (!question) return { ok: false, error: GONE.error }
  if (!question.scheduledJob.enabled) return { ok: false, error: "Turn it on first: Ask now asks a question that's on at the next minute." }
  await prisma.scheduledJob.update({ where: { id: question.scheduledJobId }, data: { nextRunAt: now, updatedById: actor.userId } })
  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "RUN_NOW",
    entityType: "RECURRING_QUESTION",
    entityId: id,
    summary: `Asked the recurring question “${question.title}” now`,
    metadata: withActorMetadata(actor),
  })
  return { ok: true, title: question.title }
}

/** The schedule a question's job runs on, as the shape officers pick (null for a cron set some other way) */
export function questionSchedule(question: QuestionWithJob) {
  return scheduleFromCron(question.scheduledJob.schedule)
}
