import { Prisma, type ActionItem, type Meeting, type MeetingDecision } from "@prisma/client"
import type { KnowledgeProvenance } from "@/lib/jack/knowledge"
import { ACTION_ITEMS_PAGE, centralDay, centralDaySpan, DECISION_TAG, decisionBody, decisionTitle, MEETINGS_PAGE, meetingPath, textKey } from "@/lib/meetings"
import {
  actionItemChangesSchema,
  actionItemFieldsSchema,
  decisionInputSchema,
  meetingChangesSchema,
  meetingFieldsSchema,
  type ActionItemChanges,
  type MeetingChanges,
} from "@/schemas/meeting.schema"
import { createAuditLog } from "@/server/audit/log"
import { prisma } from "@/server/db"
import { createKnowledgeEntry, knowledgeSecret } from "@/server/jack/knowledge/service"
import { withActorMetadata, type ServiceActor } from "./actor"
import { officerIdSet } from "./officers"

/**
 * Meetings, their decisions and action items (#188, design §13). The Meetings and Action items pages,
 * Jack's meeting.record and action_item.update proposals and the action items import target all write
 * through here.
 *
 * - The *Tx functions take a transaction, so a proposal applies a meeting and its items all or none.
 *   With `expected` they lock the row and refuse (reason "changed") when a field moved on since it was
 *   read, so a stale proposal never overwrites an officer's edit.
 * - A decision is also written to the knowledge base's decision log: an entry tagged "decision", linked
 *   from MeetingDecision.knowledgeEntryId. That goes through the knowledge service (its own transaction,
 *   versions and audit), after the meeting's own writes. One typed on the meeting page is the officer's
 *   (reviewed); one from Jack's proposal is Jack's (not reviewed, with where it came from).
 * - Action item owners must be officers. Marking one done stamps doneAt; reopening clears it.
 * - Audit entries name what changed, never an agenda's or summary's text.
 * Callers revalidate (meetingPaths, actionItemPaths): revalidatePath only works inside a request.
 */

type Db = Prisma.TransactionClient

export type MeetingWriteResult =
  | { ok: true; meeting: Meeting; changed: string[] }
  | { ok: false; reason: "invalid" | "not_found" | "changed"; error: string }

export type ActionItemWriteResult =
  | { ok: true; item: ActionItem; changed: string[] }
  | { ok: false; reason: "invalid" | "not_found" | "changed" | "owner"; error: string }

export function meetingPaths(id?: string): string[] {
  return id ? [MEETINGS_PAGE, meetingPath(id), `${meetingPath(id)}/agenda`, ACTION_ITEMS_PAGE] : [MEETINGS_PAGE, ACTION_ITEMS_PAGE]
}

export function actionItemPaths(meetingId?: string | null): string[] {
  return meetingId ? [ACTION_ITEMS_PAGE, meetingPath(meetingId)] : [ACTION_ITEMS_PAGE]
}

/** A column's value as compared and kept in `expected`: dates as ISO strings */
export function fieldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

const MEETING_GONE = { ok: false, reason: "not_found", error: "That meeting doesn't exist anymore (it may have been deleted)." } as const
const ITEM_GONE = { ok: false, reason: "not_found", error: "That action item doesn't exist anymore." } as const
const OWNER = { ok: false, reason: "owner", error: "An action item's owner has to be an officer." } as const

/** Meeting columns a meeting change can touch (type is Meeting.kind) */
const MEETING_COLUMN: Record<keyof MeetingChanges | "transcriptFileId" | "transcriptDocumentId", keyof Meeting> = {
  title: "title",
  type: "kind",
  heldAt: "heldAt",
  agendaMd: "agendaMd",
  summaryMd: "summaryMd",
  transcriptFileId: "transcriptFileId",
  transcriptDocumentId: "transcriptDocumentId",
}

/* Meetings */

/** Where a meeting came from: its transcript (a room file, or a synced Drive or SharePoint document) and the room it was recorded in */
export type MeetingLinks = { transcriptFileId?: string | null; transcriptDocumentId?: string | null; roomId?: string | null }

export async function createMeetingTx(tx: Db, input: unknown, actor: ServiceActor, links: MeetingLinks = {}): Promise<MeetingWriteResult> {
  const parsed = meetingFieldsSchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", error: parsed.error.issues[0]?.message ?? "Check the meeting." }
  const { type, ...fields } = parsed.data
  const meeting = await tx.meeting.create({
    data: { ...fields, kind: type, transcriptFileId: links.transcriptFileId ?? null, transcriptDocumentId: links.transcriptDocumentId ?? null, roomId: links.roomId ?? null, createdById: actor.userId },
  })
  await createAuditLog(
    {
      actorUserId: actor.userId,
      actionType: "CREATE",
      entityType: "MEETING",
      entityId: meeting.id,
      summary: `Recorded meeting: ${meeting.title}`,
      after: {
        title: meeting.title,
        kind: meeting.kind,
        heldAt: meeting.heldAt.toISOString(),
        agenda: Boolean(meeting.agendaMd),
        summary: Boolean(meeting.summaryMd),
        transcriptFileId: meeting.transcriptFileId,
        transcriptDocumentId: meeting.transcriptDocumentId,
      },
      metadata: withActorMetadata(actor),
    },
    tx,
  )
  return { ok: true, meeting, changed: Object.keys(parsed.data) }
}

export function createMeeting(input: unknown, actor: ServiceActor, links: MeetingLinks = {}): Promise<MeetingWriteResult> {
  return prisma.$transaction((tx) => createMeetingTx(tx, input, actor, links))
}

/** The meetings recorded on an instant's Central day (a handful at most) */
export function meetingsOnDay(db: Db | typeof prisma, at: Date): Promise<Pick<Meeting, "id" | "title" | "kind" | "heldAt">[]> {
  return db.meeting.findMany({ where: { heldAt: centralDaySpan(at) }, select: { id: true, title: true, kind: true, heldAt: true }, orderBy: { heldAt: "asc" } })
}

/**
 * Locks a title on a Central day for the rest of the transaction, so two applies recording the same new
 * meeting take turns: the second then finds the first's meeting (meetingsOnDay) instead of adding another
 */
export async function lockMeetingDayTx(tx: Db, title: string, heldAt: Date): Promise<void> {
  const key = `meeting:${title.trim().toLowerCase()}:${centralDay(heldAt)}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`
}

/**
 * What a meeting already has, by textKey: its decisions and action items. Read after its row is locked
 * (or in the transaction that created it), so a proposal can leave out what another one already added
 */
export async function meetingTextKeysTx(tx: Db, meetingId: string): Promise<{ decisions: Set<string>; actionItems: Set<string> }> {
  const [decisions, items] = await Promise.all([
    tx.meetingDecision.findMany({ where: { meetingId }, select: { text: true } }),
    tx.actionItem.findMany({ where: { meetingId }, select: { text: true } }),
  ])
  return { decisions: new Set(decisions.map((d) => textKey(d.text))), actionItems: new Set(items.map((item) => textKey(item.text))) }
}

/**
 * Changes a meeting: only the fields given (and the transcript, a room file or a synced document, when
 * given). With `expected` (column values as they were read, by change key), it refuses if any moved on
 */
export async function updateMeetingTx(
  tx: Db,
  id: string,
  input: unknown,
  actor: ServiceActor,
  options: { transcriptFileId?: string | null; transcriptDocumentId?: string | null; expected?: Partial<Record<keyof typeof MEETING_COLUMN, string | null>> } = {},
): Promise<MeetingWriteResult> {
  const parsed = meetingChangesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", error: parsed.error.issues[0]?.message ?? "Check the meeting." }
  const changes: MeetingChanges & { transcriptFileId?: string | null; transcriptDocumentId?: string | null } = {
    ...parsed.data,
    ...(options.transcriptFileId !== undefined ? { transcriptFileId: options.transcriptFileId } : {}),
    ...(options.transcriptDocumentId !== undefined ? { transcriptDocumentId: options.transcriptDocumentId } : {}),
  }

  await tx.$queryRaw`SELECT id FROM "Meeting" WHERE id = ${id} FOR UPDATE`
  const current = await tx.meeting.findUnique({ where: { id } })
  if (!current) return MEETING_GONE
  const moved = Object.entries(options.expected ?? {}).filter(([key, value]) => fieldValue(current[MEETING_COLUMN[key as keyof typeof MEETING_COLUMN]]) !== value)
  if (moved.length) return { ok: false, reason: "changed", error: `The meeting “${current.title}” changed since this was read (${moved.map(([key]) => key).join(", ")}).` }

  const changed = (Object.keys(changes) as (keyof typeof MEETING_COLUMN)[]).filter((key) => changes[key] !== undefined && fieldValue(changes[key]) !== fieldValue(current[MEETING_COLUMN[key]]))
  if (!changed.length) return { ok: true, meeting: current, changed: [] }
  const meeting = await tx.meeting.update({ where: { id }, data: Object.fromEntries(changed.map((key) => [MEETING_COLUMN[key], changes[key]])) })
  await createAuditLog(
    {
      actorUserId: actor.userId,
      actionType: "UPDATE",
      entityType: "MEETING",
      entityId: id,
      summary: `Updated meeting: ${meeting.title}`,
      before: briefMeeting(current, changed),
      after: briefMeeting(meeting, changed),
      metadata: withActorMetadata(actor, { changedFields: changed }),
    },
    tx,
  )
  return { ok: true, meeting, changed }
}

export function updateMeeting(id: string, input: unknown, actor: ServiceActor): Promise<MeetingWriteResult> {
  return prisma.$transaction((tx) => updateMeetingTx(tx, id, input, actor))
}

/** Deletes a meeting and its decisions. Its action items stay (they're still to do), and so do the decisions' knowledge entries */
export async function deleteMeeting(id: string, actor: ServiceActor): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  const meeting = await prisma.meeting.findUnique({ where: { id }, select: { title: true, kind: true, heldAt: true } })
  if (!meeting) return { ok: false, error: MEETING_GONE.error }
  await prisma.$transaction([prisma.meetingDecision.deleteMany({ where: { meetingId: id } }), prisma.meeting.delete({ where: { id } })])
  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "DELETE",
    entityType: "MEETING",
    entityId: id,
    summary: `Deleted meeting: ${meeting.title}`,
    before: { title: meeting.title, kind: meeting.kind, heldAt: meeting.heldAt.toISOString() },
    metadata: withActorMetadata(actor),
  })
  return { ok: true, title: meeting.title }
}

/* Decisions */

export type DecisionOptions = {
  /** The room a proposal came from: kept on the decision-log entry's version, like Jack's saves */
  roomId?: string | null
  /**
   * Decisions from Jack's proposal: where they came from (the reply, its tools, the proposal and file).
   * Their entries are then Jack's (sourceType JACK) and stay not reviewed until an officer marks them
   */
  provenance?: KnowledgeProvenance
  now?: Date
}

export type DecisionResult = {
  decision: MeetingDecision
  /** The decision-log entry, or why it couldn't be written (the decision is kept either way) */
  knowledge: { ok: true; entryId: string } | { ok: false; error: string }
}

/**
 * A decision's checks before it's written: its text, and nothing that looks like a secret (the decision
 * log refuses those). Null when it's fine
 */
export function decisionProblem(input: unknown): string | null {
  const parsed = decisionInputSchema.safeParse(input)
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Check the decision."
  const secret = knowledgeSecret({ title: parsed.data.title ?? decisionTitle(parsed.data.text), body: parsed.data.text })
  return secret ? `It looks like it holds ${secret}; decisions go in the knowledge base, which can't hold passwords, keys or tokens.` : null
}

/**
 * Creates decisions for a meeting in a transaction (MeetingDecision rows, decided when the meeting was
 * held). Their decision-log entries come after the transaction, with linkDecisionsToLog
 */
export async function createDecisionsTx(tx: Db, meeting: Pick<Meeting, "id" | "title" | "heldAt">, inputs: unknown[], actor: ServiceActor): Promise<MeetingDecision[]> {
  const decisions: MeetingDecision[] = []
  for (const input of inputs) {
    const parsed = decisionInputSchema.parse(input)
    decisions.push(await tx.meetingDecision.create({ data: { meetingId: meeting.id, text: parsed.text, decidedAt: meeting.heldAt } }))
  }
  if (decisions.length) {
    await createAuditLog(
      {
        actorUserId: actor.userId,
        actionType: "ADD_DECISIONS",
        entityType: "MEETING",
        entityId: meeting.id,
        summary: `Recorded ${decisions.length === 1 ? "a decision" : `${decisions.length} decisions`} for meeting: ${meeting.title}`,
        after: { decisionIds: decisions.map((d) => d.id) },
        metadata: withActorMetadata(actor),
      },
      tx,
    )
  }
  return decisions
}

/**
 * Writes each decision to the decision log: a knowledge entry tagged "decision" (and the meeting's
 * type), dated when the meeting was held and linked back to the meeting. From the meeting page it's the
 * officer's own (reviewed: they typed it); from a proposal (`provenance`) it's Jack's, applied by the
 * officer: sourceType JACK, not reviewed, with its provenance. The duplicate check is skipped: a decision
 * log has one entry per decision, the card or form already showed similar entries, and a meeting never
 * gets the same decision twice from a proposal (meetingTextKeysTx). An entry that can't be written leaves
 * its decision unlinked, with the reason
 */
export async function linkDecisionsToLog(
  meeting: Pick<Meeting, "id" | "title" | "heldAt" | "kind">,
  decisions: { decision: MeetingDecision; title?: string | null }[],
  actor: ServiceActor,
  options: DecisionOptions = {},
): Promise<DecisionResult[]> {
  const results: DecisionResult[] = []
  for (const { decision, title } of decisions) {
    let knowledge: DecisionResult["knowledge"]
    try {
      const saved = await createKnowledgeEntry(
        {
          title: title || decisionTitle(decision.text),
          body: decisionBody(decision.text, meeting),
          tags: meeting.kind === "other" ? [DECISION_TAG] : [DECISION_TAG, meeting.kind],
          sourceNote: `${meeting.title} (meeting record)`,
          sourceDate: meeting.heldAt,
          sourceUrl: meetingPath(meeting.id),
          ownerId: null,
        },
        { userId: actor.userId, via: options.provenance ? "jack" : "admin", roomId: options.roomId ?? null },
        options.provenance ? { skipDuplicateCheck: true, provenance: options.provenance } : { skipDuplicateCheck: true, reviewedAt: options.now ?? new Date() },
      )
      if (saved.ok) {
        await prisma.meetingDecision.update({ where: { id: decision.id }, data: { knowledgeEntryId: saved.entry.id } })
        knowledge = { ok: true, entryId: saved.entry.id }
      } else knowledge = { ok: false, error: saved.error }
    } catch (error) {
      console.error(`[meetings] Couldn't write decision ${decision.id} to the decision log:`, error)
      knowledge = { ok: false, error: "Couldn't write it to the decision log." }
    }
    results.push({ decision, knowledge })
  }
  return results
}

/** One decision from the meeting page: the row, then its decision-log entry */
export async function addDecision(meetingId: string, input: unknown, actor: ServiceActor, options: DecisionOptions = {}): Promise<({ ok: true } & DecisionResult) | { ok: false; error: string }> {
  const problem = decisionProblem(input)
  if (problem) return { ok: false, error: problem }
  const parsed = decisionInputSchema.parse(input)
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { id: true, title: true, heldAt: true, kind: true } })
  if (!meeting) return { ok: false, error: MEETING_GONE.error }
  const [decision] = await prisma.$transaction((tx) => createDecisionsTx(tx, meeting, [parsed], actor))
  const [result] = await linkDecisionsToLog(meeting, [{ decision, title: parsed.title }], actor, options)
  return { ok: true, ...result }
}

/** Removes a decision from its meeting. Its decision-log entry stays; archive it on its Knowledge page if it's wrong */
export async function removeDecision(decisionId: string, actor: ServiceActor): Promise<{ ok: true; meetingId: string | null } | { ok: false; error: string }> {
  const decision = await prisma.meetingDecision.findUnique({ where: { id: decisionId }, select: { id: true, meetingId: true, knowledgeEntryId: true, meeting: { select: { title: true } } } })
  if (!decision) return { ok: false, error: "That decision doesn't exist anymore." }
  await prisma.meetingDecision.delete({ where: { id: decisionId } })
  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "REMOVE_DECISION",
    entityType: "MEETING",
    entityId: decision.meetingId ?? decisionId,
    summary: `Removed a decision${decision.meeting ? ` from meeting: ${decision.meeting.title}` : ""}`,
    before: { decisionId, knowledgeEntryId: decision.knowledgeEntryId },
    metadata: withActorMetadata(actor),
  })
  return { ok: true, meetingId: decision.meetingId }
}

/* Action items */

export type ActionItemLinks = { meetingId?: string | null; roomId?: string | null }

export async function createActionItemTx(tx: Db, input: unknown, actor: ServiceActor, links: ActionItemLinks = {}): Promise<ActionItemWriteResult> {
  const parsed = actionItemFieldsSchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", error: parsed.error.issues[0]?.message ?? "Check the action item." }
  if (parsed.data.ownerId && !(await officerIdSet([parsed.data.ownerId], tx)).has(parsed.data.ownerId)) return OWNER
  const item = await tx.actionItem.create({ data: { ...parsed.data, meetingId: links.meetingId ?? null, roomId: links.roomId ?? null, createdById: actor.userId } })
  await createAuditLog(
    {
      actorUserId: actor.userId,
      actionType: "CREATE",
      entityType: "ACTION_ITEM",
      entityId: item.id,
      targetUserId: item.ownerId,
      summary: `Added action item: ${clip(item.text)}`,
      after: { text: item.text, ownerId: item.ownerId, dueAt: fieldValue(item.dueAt), meetingId: item.meetingId },
      metadata: withActorMetadata(actor),
    },
    tx,
  )
  return { ok: true, item, changed: Object.keys(parsed.data) }
}

export function createActionItem(input: unknown, actor: ServiceActor, links: ActionItemLinks = {}): Promise<ActionItemWriteResult> {
  return prisma.$transaction((tx) => createActionItemTx(tx, input, actor, links))
}

/**
 * Changes an action item: only the fields given. Done stamps doneAt (now); open or dropped clears it.
 * With `expected` (values as they were read), it refuses if any moved on
 */
export async function updateActionItemTx(
  tx: Db,
  id: string,
  input: unknown,
  actor: ServiceActor,
  options: { expected?: Partial<Record<keyof ActionItemChanges, string | null>>; now?: Date } = {},
): Promise<ActionItemWriteResult> {
  const parsed = actionItemChangesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", error: parsed.error.issues[0]?.message ?? "Check the action item." }
  const changes = parsed.data

  await tx.$queryRaw`SELECT id FROM "ActionItem" WHERE id = ${id} FOR UPDATE`
  const current = await tx.actionItem.findUnique({ where: { id } })
  if (!current) return ITEM_GONE
  const moved = Object.entries(options.expected ?? {}).filter(([key, value]) => fieldValue(current[key as keyof ActionItemChanges]) !== value)
  if (moved.length) return { ok: false, reason: "changed", error: `The action item “${clip(current.text)}” changed since this was read (${moved.map(([key]) => key).join(", ")}).` }

  const changed = (Object.keys(changes) as (keyof ActionItemChanges)[]).filter((key) => changes[key] !== undefined && fieldValue(changes[key]) !== fieldValue(current[key]))
  if (!changed.length) return { ok: true, item: current, changed: [] }
  if (changed.includes("ownerId") && changes.ownerId && !(await officerIdSet([changes.ownerId], tx)).has(changes.ownerId)) return OWNER

  const data: Prisma.ActionItemUncheckedUpdateInput = Object.fromEntries(changed.map((key) => [key, changes[key]]))
  if (changed.includes("status")) data.doneAt = changes.status === "done" ? (options.now ?? new Date()) : null
  const item = await tx.actionItem.update({ where: { id }, data })
  await createAuditLog(
    {
      actorUserId: actor.userId,
      actionType: changed.length === 1 && changed[0] === "status" ? (item.status === "done" ? "MARK_DONE" : item.status === "dropped" ? "DROP" : "REOPEN") : "UPDATE",
      entityType: "ACTION_ITEM",
      entityId: id,
      targetUserId: item.ownerId,
      summary: `${item.status === "done" && changed.includes("status") ? "Marked done" : "Updated"} action item: ${clip(item.text)}`,
      before: Object.fromEntries(changed.map((key) => [key, fieldValue(current[key])])),
      after: Object.fromEntries(changed.map((key) => [key, fieldValue(item[key])])),
      metadata: withActorMetadata(actor, { changedFields: changed }),
    },
    tx,
  )
  return { ok: true, item, changed }
}

export function updateActionItem(id: string, input: unknown, actor: ServiceActor, options: { expected?: Partial<Record<keyof ActionItemChanges, string | null>> } = {}): Promise<ActionItemWriteResult> {
  return prisma.$transaction((tx) => updateActionItemTx(tx, id, input, actor, options))
}

/* Helpers */

function briefMeeting(meeting: Meeting, changed: string[]): Record<string, unknown> {
  // Agenda and summary text stay out of the audit log: only whether there is one
  return Object.fromEntries(
    changed.map((key) => {
      const column = MEETING_COLUMN[key as keyof typeof MEETING_COLUMN]
      const value = meeting[column]
      return [key, column === "agendaMd" || column === "summaryMd" ? Boolean(value) : fieldValue(value)]
    }),
  )
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
