import { Prisma, type SponsorActivity, type SponsorProspect } from "@prisma/client"
import { companyKey, CONTACT_TYPES, type ActivityType, type ProspectStage, prospectPath, SPONSORS_PAGE, stageChangeSummary } from "@/lib/sponsor-prospects"
import {
  activitySchema,
  PROSPECT_PERSONAL_FIELDS,
  prospectChangesSchema,
  prospectFieldsSchema,
  type ActivityInput,
  type ProspectChanges,
  type ProspectFieldKey,
} from "@/schemas/sponsor-prospect.schema"
import { createAuditLog } from "@/server/audit/log"
import { prisma } from "@/server/db"
import { withActorMetadata, type ServiceActor } from "./actor"
import { officerIdSet } from "./officers"

/**
 * Sponsor prospects and their activity (#188, design §13). The Sponsors page, Jack's prospect.upsert and
 * prospect.activity proposals and the prospects import target all write through here, so they share the
 * checks, the stage-change log and the audit entries.
 *
 * - The *Tx functions take a transaction, so a proposal can apply several prospects all or none. Each
 *   locks the prospect's row first, and with `expected` it refuses (reason "changed") when a field moved
 *   on since it was read, so a stale proposal never overwrites an officer's edit.
 * - A stage change logs a stage_change activity; contact (an email, reply, call or meeting) moves
 *   lastContactAt forward.
 * - Owners must be officers.
 * - Audit entries name the company and the fields changed, never the contact's details, the next step or
 *   the notes, so deleting a prospect really removes them.
 * Callers revalidate (prospectPaths): revalidatePath only works inside a request.
 */

type Db = Prisma.TransactionClient

export type ProspectWriteResult =
  | { ok: true; prospect: SponsorProspect; changed: ProspectFieldKey[] }
  | { ok: false; reason: "invalid" | "not_found" | "changed" | "duplicate" | "owner"; error: string; duplicateId?: string }

export type ActivityWriteResult =
  | { ok: true; activity: SponsorActivity; prospect: SponsorProspect; changed: ProspectFieldKey[] }
  | { ok: false; reason: "invalid" | "not_found" | "changed" | "owner"; error: string }

/** The admin pages a prospect change shows on */
export function prospectPaths(id?: string): string[] {
  return id ? [SPONSORS_PAGE, prospectPath(id)] : [SPONSORS_PAGE]
}

const NOT_FOUND = { ok: false, reason: "not_found", error: "That prospect doesn't exist anymore (it may have been deleted)." } as const
const OWNER = { ok: false, reason: "owner", error: "A prospect's owner has to be an officer." } as const

/** A field's value in a form that compares and stores as JSON: dates as ISO strings */
export function prospectValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/** Fields the audit entry may show (never the contact's details, the next step or the notes) */
function auditable(fields: Partial<Record<ProspectFieldKey, unknown>>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !PROSPECT_PERSONAL_FIELDS.includes(key as ProspectFieldKey)).map(([key, value]) => [key, prospectValue(value)]))
}

const lockProspect = (tx: Db, id: string) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SponsorProspect" WHERE id = ${id} FOR UPDATE`

/** The prospect already there under the same company name (companyKey), if any */
export async function findProspectByCompany(company: string, db: Db | typeof prisma = prisma, exceptId?: string): Promise<{ id: string; company: string } | null> {
  const key = companyKey(company)
  if (!key) return null
  // Names are short and prospects few: compare every one the way companyKey does
  const rows = await db.sponsorProspect.findMany({ where: exceptId ? { id: { not: exceptId } } : {}, select: { id: true, company: true } })
  return rows.find((row) => companyKey(row.company) === key) ?? null
}

/** Adds a prospect inside a transaction. `fields` are checked again here */
export async function createProspectTx(tx: Db, input: unknown, actor: ServiceActor, options: { allowDuplicate?: boolean } = {}): Promise<ProspectWriteResult> {
  const parsed = prospectFieldsSchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", error: parsed.error.issues[0]?.message ?? "Check the prospect." }
  const fields = parsed.data
  if (fields.ownerId && !(await officerIdSet([fields.ownerId], tx)).has(fields.ownerId)) return OWNER
  if (!options.allowDuplicate) {
    const existing = await findProspectByCompany(fields.company, tx)
    if (existing) return { ok: false, reason: "duplicate", error: `${existing.company} is already a prospect.`, duplicateId: existing.id }
  }

  const prospect = await tx.sponsorProspect.create({ data: { ...fields, createdById: actor.userId } })
  await createAuditLog(
    {
      actorUserId: actor.userId,
      actionType: "CREATE",
      entityType: "SPONSOR_PROSPECT",
      entityId: prospect.id,
      summary: `Added sponsor prospect: ${prospect.company}`,
      after: auditable(fields),
      metadata: withActorMetadata(actor),
    },
    tx,
  )
  return { ok: true, prospect, changed: Object.keys(fields) as ProspectFieldKey[] }
}

export function createProspect(input: unknown, actor: ServiceActor, options: { allowDuplicate?: boolean } = {}): Promise<ProspectWriteResult> {
  return prisma.$transaction((tx) => createProspectTx(tx, input, actor, options))
}

/**
 * Changes a prospect inside a transaction: only the fields given. With `expected` (fields as they were
 * read), it changes nothing and says "changed" if any of them moved on since. A stage change logs a
 * stage_change activity
 */
export async function updateProspectTx(
  tx: Db,
  id: string,
  input: unknown,
  actor: ServiceActor,
  options: { expected?: Partial<Record<ProspectFieldKey, string | null>>; now?: Date } = {},
): Promise<ProspectWriteResult> {
  const parsed = prospectChangesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", error: parsed.error.issues[0]?.message ?? "Check the prospect." }
  const changes: ProspectChanges = parsed.data

  await lockProspect(tx, id)
  const current = await tx.sponsorProspect.findUnique({ where: { id } })
  if (!current) return NOT_FOUND
  const moved = movedFields(current, options.expected)
  if (moved.length) return changedError(current, moved)

  const changed = (Object.keys(changes) as ProspectFieldKey[]).filter((key) => changes[key] !== undefined && prospectValue(changes[key]) !== prospectValue(current[key]))
  if (!changed.length) return { ok: true, prospect: current, changed: [] }
  if (changed.includes("ownerId") && changes.ownerId && !(await officerIdSet([changes.ownerId], tx)).has(changes.ownerId)) return OWNER
  if (changed.includes("company")) {
    const existing = await findProspectByCompany(changes.company!, tx, id)
    if (existing) return { ok: false, reason: "duplicate", error: `${existing.company} is already a prospect.`, duplicateId: existing.id }
  }

  const data = Object.fromEntries(changed.map((key) => [key, changes[key]])) as Prisma.SponsorProspectUpdateInput
  const prospect = await tx.sponsorProspect.update({ where: { id }, data })
  if (changed.includes("stage")) {
    await tx.sponsorActivity.create({ data: { prospectId: id, type: "stage_change", summary: stageChangeSummary(current.stage, prospect.stage), occurredAt: options.now ?? new Date(), byId: actor.userId } })
  }
  await createAuditLog(
    {
      actorUserId: actor.userId,
      actionType: "UPDATE",
      entityType: "SPONSOR_PROSPECT",
      entityId: id,
      summary: `Updated sponsor prospect: ${prospect.company}`,
      before: auditable(pick(current, changed)),
      after: auditable(pick(prospect, changed)),
      metadata: withActorMetadata(actor, { changedFields: changed }),
    },
    tx,
  )
  return { ok: true, prospect, changed }
}

export function updateProspect(id: string, input: unknown, actor: ServiceActor, options: { expected?: Partial<Record<ProspectFieldKey, string | null>> } = {}): Promise<ProspectWriteResult> {
  return prisma.$transaction((tx) => updateProspectTx(tx, id, input, actor, options))
}

export type LogActivityOptions = {
  /** Who did it (the officer who reported it), when that isn't the actor */
  byId?: string | null
  /** Also move the prospect to this stage (logs a stage_change too) */
  stage?: ProspectStage
  nextStep?: string | null
  nextStepDue?: Date | null
  /** As for updateProspectTx: the fields this changes, as they were read */
  expected?: Partial<Record<ProspectFieldKey, string | null>>
  now?: Date
}

/** Logs an activity on a prospect inside a transaction, with an optional stage and next-step change */
export async function logProspectActivityTx(tx: Db, prospectId: string, input: unknown, actor: ServiceActor, options: LogActivityOptions = {}): Promise<ActivityWriteResult> {
  const parsed = activitySchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", error: parsed.error.issues[0]?.message ?? "Check the activity." }
  const activity: ActivityInput = parsed.data
  const extra = prospectChangesSchema.pick({ stage: true, nextStep: true, nextStepDue: true }).safeParse({ stage: options.stage, nextStep: options.nextStep, nextStepDue: options.nextStepDue })
  if (!extra.success) return { ok: false, reason: "invalid", error: extra.error.issues[0]?.message ?? "Check the next step." }
  options = { ...options, ...extra.data }

  await lockProspect(tx, prospectId)
  const current = await tx.sponsorProspect.findUnique({ where: { id: prospectId } })
  if (!current) return NOT_FOUND
  const moved = movedFields(current, options.expected)
  if (moved.length) {
    const error = changedError(current, moved)
    return { ok: false, reason: "changed", error: error.error }
  }

  const created = await tx.sponsorActivity.create({
    data: { prospectId, type: activity.type, summary: activity.summary, occurredAt: activity.occurredAt, byId: options.byId === undefined ? actor.userId : options.byId },
  })

  const changes: ProspectChanges = {}
  if (options.stage && options.stage !== current.stage) changes.stage = options.stage
  if (options.nextStep !== undefined && options.nextStep !== current.nextStep) changes.nextStep = options.nextStep
  if (options.nextStepDue !== undefined && prospectValue(options.nextStepDue) !== prospectValue(current.nextStepDue)) changes.nextStepDue = options.nextStepDue
  const changed = Object.keys(changes) as ProspectFieldKey[]
  // Contact (not a note) moves the last contact forward; logging an older one leaves it
  const contact = CONTACT_TYPES.includes(activity.type) && (!current.lastContactAt || current.lastContactAt < activity.occurredAt)

  const prospect =
    changed.length || contact
      ? await tx.sponsorProspect.update({ where: { id: prospectId }, data: { ...(changes as Prisma.SponsorProspectUpdateInput), ...(contact ? { lastContactAt: activity.occurredAt } : {}) } })
      : current
  if (changes.stage) {
    await tx.sponsorActivity.create({ data: { prospectId, type: "stage_change", summary: stageChangeSummary(current.stage, changes.stage), occurredAt: options.now ?? new Date(), byId: actor.userId } })
  }
  await createAuditLog(
    {
      actorUserId: actor.userId,
      actionType: "LOG_ACTIVITY",
      entityType: "SPONSOR_PROSPECT",
      entityId: prospectId,
      summary: `Logged ${activityPhrase(activity.type)} for sponsor prospect: ${current.company}`,
      after: { activityId: created.id, type: activity.type, occurredAt: activity.occurredAt.toISOString(), ...auditable(pick(prospect, changed)) },
      metadata: withActorMetadata(actor, changed.length ? { changedFields: changed } : {}),
    },
    tx,
  )
  return { ok: true, activity: created, prospect, changed }
}

export function logProspectActivity(prospectId: string, input: unknown, actor: ServiceActor, options: LogActivityOptions = {}): Promise<ActivityWriteResult> {
  return prisma.$transaction((tx) => logProspectActivityTx(tx, prospectId, input, actor, options))
}

/** Removes one logged activity (a mistake); stage changes stay in the log */
export async function deleteProspectActivity(activityId: string, actor: ServiceActor): Promise<{ ok: true; prospectId: string } | { ok: false; error: string }> {
  const activity = await prisma.sponsorActivity.findUnique({ where: { id: activityId }, select: { id: true, type: true, occurredAt: true, prospect: { select: { id: true, company: true } } } })
  if (!activity) return { ok: false, error: "That activity doesn't exist anymore." }
  if (activity.type === "stage_change") return { ok: false, error: "Stage changes stay in the log. Change the stage instead." }
  await prisma.sponsorActivity.delete({ where: { id: activityId } })
  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "DELETE_ACTIVITY",
    entityType: "SPONSOR_PROSPECT",
    entityId: activity.prospect.id,
    summary: `Removed ${activityPhrase(activity.type)} from sponsor prospect: ${activity.prospect.company}`,
    before: { activityId, type: activity.type, occurredAt: activity.occurredAt.toISOString() },
    metadata: withActorMetadata(actor),
  })
  return { ok: true, prospectId: activity.prospect.id }
}

/** Deletes a prospect and its activity for good. The audit entry keeps only the company's name */
export async function deleteProspect(id: string, actor: ServiceActor): Promise<{ ok: true; company: string } | { ok: false; error: string }> {
  const prospect = await prisma.sponsorProspect.findUnique({ where: { id }, select: { company: true, stage: true } })
  if (!prospect) return { ok: false, error: NOT_FOUND.error }
  await prisma.sponsorProspect.delete({ where: { id } })
  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "DELETE",
    entityType: "SPONSOR_PROSPECT",
    entityId: id,
    summary: `Deleted sponsor prospect: ${prospect.company}`,
    before: { company: prospect.company, stage: prospect.stage },
    metadata: withActorMetadata(actor),
  })
  return { ok: true, company: prospect.company }
}

/* Helpers */

/** Fields in `expected` whose value isn't that any more */
function movedFields(current: SponsorProspect, expected: Partial<Record<ProspectFieldKey, string | null>> | undefined): ProspectFieldKey[] {
  if (!expected) return []
  return (Object.keys(expected) as ProspectFieldKey[]).filter((key) => prospectValue(current[key]) !== expected[key])
}

function changedError(current: SponsorProspect, moved: ProspectFieldKey[]) {
  return { ok: false, reason: "changed", error: `${current.company} changed since this was read (${moved.join(", ")}).` } as const
}

function pick<T extends object>(row: T, keys: string[]): Partial<Record<ProspectFieldKey, unknown>> {
  return Object.fromEntries(keys.map((key) => [key, (row as Record<string, unknown>)[key]]))
}

function activityPhrase(type: string): string {
  const phrases: Record<ActivityType | "stage_change", string> = { email_sent: "an email", reply: "a reply", meeting: "a meeting", call: "a call", note: "a note", stage_change: "a stage change" }
  return phrases[type as ActivityType] ?? "an activity"
}
