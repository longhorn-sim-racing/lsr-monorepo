import type { Meeting } from "@prisma/client"
import { z } from "zod"
import type { KnowledgeProvenance } from "@/lib/jack/knowledge"
import { parseToolParts } from "@/lib/jack/parts"
import {
  ACTION_ITEMS_PAGE,
  centralDay,
  decisionTitle,
  dueDateValue,
  formatMeetingTime,
  MEETING_LIMITS,
  MEETING_TYPES,
  meetingAgendaPath,
  meetingPath,
  meetingTimeInput,
  meetingTimeValue,
  meetingTypeLabel,
  sameMeetingTitle,
  textKey,
} from "@/lib/meetings"
import { MEETING_FIELD_LABEL, meetingChangesSchema, meetingFieldsSchema, type MeetingChanges } from "@/schemas/meeting.schema"
import { prisma } from "@/server/db"
import { findKnowledgeDuplicates } from "@/server/jack/knowledge/service"
import {
  createActionItemTx,
  createDecisionsTx,
  createMeetingTx,
  decisionProblem,
  fieldValue,
  linkDecisionsToLog,
  lockMeetingDayTx,
  meetingPaths,
  meetingsOnDay,
  meetingTextKeysTx,
  updateMeetingTx,
} from "@/server/services/meeting.service"
import { userNames, type OfficerRef } from "@/server/services/officers"
import { centralDateInput } from "../../tools/time"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalDiffRow, ProposalKind, ProposalLink, ProposalPerson, ProposalRow } from "../types"
import { cardDay, clip, handleInput, idInput, officerFor, plural, resolveOfficers, revalidateQuietly } from "./shared"

/**
 * meeting.record (design §4.3, sponsors-meetings): a meeting with its agenda and summary, the decisions
 * made (each also written to the decision log: a knowledge entry tagged "decision") and the action items
 * (owners by handle, due dates). It can add to a meeting already recorded (meetingId): an agenda before
 * the meeting, the summary, decisions and items after. Built from a transcript or notes in the room, it
 * names the file as `fileId` (checked unchanged at apply) and the meeting keeps it as its transcript.
 *
 * Decisions and action items are rows on the card, so officers apply the ones that are right. So is the
 * meeting itself (row "m": a new meeting, or the changes to its own fields), so an officer can keep it
 * without any of them; a new meeting's decisions and items need it picked. The meeting and the picked
 * rows are written in one transaction; then each decision's knowledge entry, through the knowledge
 * service, as Jack's (not reviewed, with where it came from).
 *
 * Repeats: a new meeting whose title is already recorded that Central day is refused when proposed and
 * again at apply (under a lock on the title and day). A newer proposal for a new meeting of the same type
 * on the same day supersedes an older one in the room (targetId "new:<day>:<type>"), so a corrected
 * title replaces the card. A decision or action item the meeting already has is left out at apply.
 */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
/** Files a meeting record can be built from (G5 extracts their text: VTT and DOCX with speakers) */
const TRANSCRIPT_KINDS = ["TRANSCRIPT", "DOCUMENT", "TEXT", "PDF"]
/** Most of the proposing reply's earlier tool calls a decision's provenance keeps, and how much of each one's input */
const PROVENANCE_TOOLS = 12
const PROVENANCE_INPUT_CHARS = 200

const decisionInput = z.object({
  text: z.string().trim().min(3).max(MEETING_LIMITS.decisionMax).describe("The decision, one plain sentence in the meeting's words"),
  title: z.string().trim().min(3).max(MEETING_LIMITS.decisionTitleMax).optional().describe("A short title for its decision-log entry (made from the text when left out)"),
})

const itemInput = z.object({
  text: z.string().trim().min(3).max(MEETING_LIMITS.actionItemMax),
  owner: handleInput.optional().describe("Handle of the officer who'll do it"),
  due: centralDateInput.optional().describe("Central due date, YYYY-MM-DD, when one was said"),
})

export const meetingRecordSchema = z
  .object({
    meetingId: idInput.optional().describe("To add to a meeting already recorded (from meetings_list). Leave out for a new meeting"),
    title: z.string().trim().min(3).max(MEETING_LIMITS.titleMax).optional().describe('Required for a new meeting, e.g. "Board meeting"'),
    type: z.enum(MEETING_TYPES).optional().describe("Required for a new meeting"),
    date: centralDateInput.optional().describe("Central date it's held, YYYY-MM-DD; required for a new meeting"),
    time: z.string().regex(TIME, "Use a 24-hour time like 18:30").optional().describe("Central start time, HH:MM, when known (give the date too). Left out on a recorded meeting, its time stays"),
    agenda: z.string().trim().max(MEETING_LIMITS.textMax).optional().describe("Markdown"),
    summary: z.string().trim().max(MEETING_LIMITS.textMax).optional().describe("Markdown: what was discussed"),
    fileId: idInput.optional().describe("The room file it's built from (a transcript or notes)"),
    decisions: z.array(decisionInput).max(30).optional().describe("Only what was actually decided; each also goes to the decision log"),
    actionItems: z.array(itemInput).max(50).optional(),
  })
  .superRefine((p, ctx) => {
    if (!p.meetingId) {
      for (const field of ["title", "type", "date"] as const) if (p[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message: `a new meeting needs its ${field}` })
    } else if ([p.title, p.type, p.date, p.agenda, p.summary, p.fileId].every((v) => v === undefined) && !p.decisions?.length && !p.actionItems?.length) {
      ctx.addIssue({ code: "custom", path: ["meetingId"], message: "nothing to add to the meeting" })
    }
    if (p.time !== undefined && p.date === undefined) ctx.addIssue({ code: "custom", path: ["time"], message: "give the date with the time" })
  })

export type MeetingRecord = z.infer<typeof meetingRecordSchema>

const recordBefore = z.object({
  /** Updates: the meeting's fields this changes, as they were (by change key) */
  meetingId: z.string().nullable(),
  fields: z.record(z.string(), z.string().nullable()),
})

/** The meeting's own row: a new meeting, or the changes to a recorded one's fields */
const MEETING_ROW = "m"
const decisionRowId = (i: number) => `d${i + 1}`
const itemRowId = (i: number) => `a${i + 1}`

/**
 * The meeting's fields from the payload, only the ones given (heldAt from the date and time). A date
 * without a time on a recorded meeting keeps its time of day (`current`: its heldAt)
 */
function payloadFields(p: MeetingRecord, current?: Date | null): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (p.title !== undefined) fields.title = p.title
  if (p.type !== undefined) fields.type = p.type
  if (p.date !== undefined) fields.heldAt = meetingTimeValue(p.date, p.time ?? (current ? meetingTimeInput(current) || null : null))
  if (p.agenda !== undefined) fields.agendaMd = p.agenda
  if (p.summary !== undefined) fields.summaryMd = p.summary
  return fields
}

/** The meeting's column for each change key */
const COLUMN = { title: "title", type: "kind", heldAt: "heldAt", agendaMd: "agendaMd", summaryMd: "summaryMd" } as const satisfies Record<keyof MeetingChanges, keyof Meeting>

function showField(key: keyof MeetingChanges, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (key === "heldAt") return formatMeetingTime(value as Date)
  if (key === "type") return meetingTypeLabel(String(value))
  return String(value)
}

/** The room file the record names: this room's, ready, and a kind of document with text */
async function transcriptFile(fileId: string, roomId: string) {
  const file = await prisma.jackFile.findUnique({ where: { id: fileId }, select: { id: true, roomId: true, filename: true, status: true, kind: true, sha256: true } })
  if (!file || file.roomId !== roomId) throw new ProposalInputError(`There's no file ${fileId} in this room. Use a file id from room_files.`)
  if (file.status !== "READY" || !file.sha256) throw new ProposalInputError(`${file.filename} isn't ready yet (it may still be uploading, or it failed).`)
  if (!TRANSCRIPT_KINDS.includes(file.kind)) throw new ProposalInputError(`${file.filename} isn't a transcript or notes (VTT, Word, text or PDF).`)
  return file
}

/** The decision's knowledge entry title: the one given, or made from the text */
const titleOf = (d: { text: string; title?: string }) => d.title ?? decisionTitle(d.text)

/** True the first time a text is seen on the meeting (and remembers it); false for one it already has */
function isNew(seen: Set<string>, text: string): boolean {
  const key = textKey(text)
  if (seen.has(key)) return false
  seen.add(key)
  return true
}

/**
 * Where a proposal's decisions came from, kept on their decision-log entries (the Knowledge page shows
 * it): the reply that proposed them, the tools it used first (a transcript read, a page fetched), the
 * officer messages it answered and who asked, then the proposal itself, its file and who applied it
 */
async function proposalProvenance(ctx: ProposalApplyContext, fileId: string | undefined, now: Date): Promise<KnowledgeProvenance> {
  const proposal = await prisma.jackProposal.findUnique({ where: { id: ctx.proposalId }, select: { messageId: true, proposedForId: true } })
  const replyId = proposal?.messageId ?? null
  const askedById = proposal?.proposedForId ?? null
  const [reply, asked, names, file] = await Promise.all([
    replyId ? prisma.jackMessage.findUnique({ where: { id: replyId }, select: { toolCalls: true } }) : null,
    replyId ? prisma.jackMessage.findMany({ where: { answeredById: replyId, kind: "user" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } }) : [],
    userNames([askedById]),
    fileId ? prisma.jackFile.findUnique({ where: { id: fileId }, select: { filename: true } }) : null,
  ])
  const tools = parseToolParts(reply?.toolCalls)
    .filter((part) => !part.name.startsWith("propose_"))
    .slice(-PROVENANCE_TOOLS)
    .map((part) => ({ name: part.name, input: clip(JSON.stringify(part.input ?? null), PROVENANCE_INPUT_CHARS), label: part.label }))
  return {
    roomId: ctx.roomId,
    replyId,
    messageIds: asked.map((m) => m.id),
    askedBy: { userId: askedById, name: (askedById && names.get(askedById)?.displayName) || "An officer" },
    tools: [
      ...tools,
      {
        name: "propose_meeting",
        input: JSON.stringify({ proposalId: ctx.proposalId, ...(fileId ? { fileId } : {}) }),
        label: `Meeting record applied by ${ctx.officer.displayName}${file ? `, from ${file.filename}` : ""}`,
      },
    ],
    at: now.toISOString(),
  }
}

export const meetingRecordKind: ProposalKind<MeetingRecord> = {
  kind: "meeting.record",
  tool: "propose_meeting",
  description:
    "meeting.record: record a meeting (title, type, date, agenda, summary), its decisions (also written to the decision log in Knowledge) and its action items (owners by handle, due dates), or add any of these to a meeting already recorded (meetingId from meetings_list). From a transcript or notes in the room, name the file as fileId. To fix a new meeting you proposed, propose it again: the newer card replaces it.",
  schema: meetingRecordSchema,
  targetType: "MEETING",
  permission: "officer",

  async prepare(p, ctx) {
    const items = p.actionItems ?? []
    const decisions = p.decisions ?? []
    const owners = await resolveOfficers(
      items.map((item) => item.owner),
      "An action item's owner",
    )
    decisions.forEach((d, i) => {
      const problem = decisionProblem(d)
      if (problem) throw new ProposalInputError(`Decision ${i + 1}: ${problem}`)
    })
    const file = p.fileId ? await transcriptFile(p.fileId, ctx.roomId) : null
    const current = p.meetingId ? await prisma.meeting.findUnique({ where: { id: p.meetingId } }) : null
    if (p.meetingId && !current) throw new ProposalInputError(`There's no meeting with id ${p.meetingId}. Find it with meetings_list.`)

    const fields = payloadFields(p, current?.heldAt)
    const diff: ProposalDiffRow[] = []
    let meeting: { id: string | null; title: string; heldAt: Date }
    let before: z.infer<typeof recordBefore> = { meetingId: null, fields: {} }
    let targetId: string | undefined
    /** What the meeting's own row covers */
    let meetingDetail: string
    let sameDayNote = ""
    if (current) {
      const parsed = meetingChangesSchema.safeParse(fields)
      if (!parsed.success) throw new ProposalInputError(parsed.error.issues[0]?.message ?? "Check the meeting's fields.")
      const changes = parsed.data
      const keys = (Object.keys(changes) as (keyof MeetingChanges)[]).filter((key) => changes[key] !== undefined && fieldValue(changes[key]) !== fieldValue(current[COLUMN[key]]))
      for (const key of keys) diff.push({ field: key, label: MEETING_FIELD_LABEL[key], before: showField(key, current[COLUMN[key]]), after: showField(key, changes[key]), format: key === "agendaMd" || key === "summaryMd" ? "markdown" : "text" })
      const fileChanges = file && file.id !== current.transcriptFileId
      if (fileChanges) diff.push({ field: "transcriptFileId", label: "Transcript", before: current.transcriptFileId ? "A room file" : null, after: file.filename, format: "text" })
      if (!keys.length && !fileChanges && !decisions.length && !items.length) throw new ProposalInputError(`Nothing would change: “${current.title}” already has these details.`)
      before = {
        meetingId: current.id,
        fields: { ...Object.fromEntries(keys.map((key) => [key, fieldValue(current[COLUMN[key]])])), ...(fileChanges ? { transcriptFileId: current.transcriptFileId } : {}) },
      }
      meeting = { id: current.id, title: changes.title ?? current.title, heldAt: changes.heldAt ?? current.heldAt }
      meetingDetail = diff.map((row) => row.label).join(", ")
      // A newer change to the meeting's own fields replaces this one; adding decisions or items alone doesn't (repeats are left out at apply)
      if (Object.keys(before.fields).length) targetId = current.id
    } else {
      const parsed = meetingFieldsSchema.safeParse(fields)
      if (!parsed.success) throw new ProposalInputError(parsed.error.issues[0]?.message ?? "Check the meeting's fields.")
      const m = parsed.data
      const sameDay = await meetingsOnDay(prisma, m.heldAt)
      const same = sameDay.find((other) => sameMeetingTitle(other.title, m.title))
      if (same) throw new ProposalInputError(`“${same.title}” on ${cardDay(m.heldAt)} is already recorded (id ${same.id}). To add to it, give its meetingId.`)
      const sameType = sameDay.filter((other) => other.kind === m.type)
      if (sameType.length) sameDayNote = ` Already recorded that day: ${sameType.slice(0, 2).map((other) => `“${other.title}”`).join(", ")}; check this isn't the same meeting.`
      diff.push(
        { field: "title", label: "Title", before: null, after: m.title, format: "text" },
        { field: "type", label: "Type", before: null, after: meetingTypeLabel(m.type), format: "value" },
        { field: "heldAt", label: "When", before: null, after: formatMeetingTime(m.heldAt), format: "value" },
        ...(m.agendaMd ? [{ field: "agendaMd", label: "Agenda", before: null, after: m.agendaMd, format: "markdown" as const }] : []),
        ...(m.summaryMd ? [{ field: "summaryMd", label: "Summary", before: null, after: m.summaryMd, format: "markdown" as const }] : []),
        ...(file ? [{ field: "transcriptFileId", label: "Transcript", before: null, after: file.filename, format: "text" as const }] : []),
      )
      meeting = { id: null, title: m.title, heldAt: m.heldAt }
      meetingDetail = `${["Title, type and time", m.agendaMd ? "agenda" : null, m.summaryMd ? "summary" : null, file ? "transcript" : null].filter(Boolean).join(", ")}. Keep it picked to apply any decision or action item`
      // A newer new-meeting proposal for the same day and type replaces this one (a corrected title, say)
      targetId = `new:${centralDay(m.heldAt)}:${m.type}`
    }

    const rows: ProposalRow[] = []
    for (const [i, d] of decisions.entries()) {
      const similar = await findKnowledgeDuplicates({ title: titleOf(d), body: d.text, tags: ["decision"] })
      const title = titleOf(d)
      rows.push({
        id: decisionRowId(i),
        label: `Decision: ${title}`,
        // The whole text: it's what goes to the decision log
        detail: [d.text !== title ? d.text : null, similar.length ? `Similar in Knowledge: ${similar.slice(0, 2).map((s) => `“${s.title}”`).join(", ")}` : null].filter(Boolean).join(" · ") || undefined,
      })
    }
    const people = new Map<string, ProposalPerson>()
    for (const [i, item] of items.entries()) {
      const owner = officerFor(owners, item.owner)
      if (owner) people.set(owner.id, { name: owner.displayName, detail: "Action items" })
      rows.push({
        id: itemRowId(i),
        label: `Action item: ${clip(item.text, 120)}`,
        detail: [item.text.length > 120 ? item.text : null, owner ? owner.displayName : "No owner", item.due ? `due ${cardDay(dueDateValue(item.due))}` : "no due date"].filter(Boolean).join(" · "),
      })
    }
    // The meeting's own row, so it can be kept without any decision or item (only offered alongside them)
    if (rows.length && (!meeting.id || diff.length)) {
      rows.unshift({ id: MEETING_ROW, label: meeting.id ? `Changes to “${meeting.title}”` : `Meeting: ${meeting.title} (${cardDay(meeting.heldAt)})`, detail: meetingDetail })
    }

    const parts = [
      decisions.length ? plural(decisions.length, "decision") : null,
      items.length ? plural(items.length, "action item") : null,
    ].filter(Boolean)
    const title = meeting.id ? `Add to the meeting “${meeting.title}”` : `Record the meeting “${meeting.title}” (${cardDay(meeting.heldAt)})`
    const summary = `Applying it ${meeting.id ? "updates the meeting" : "records the meeting"}${parts.length ? ` with ${parts.join(" and ")}` : ""}.${decisions.length ? " Each decision also goes to the decision log in Knowledge, as Jack's, not reviewed until an officer marks it." : ""}${rows.length > 1 ? " Pick what to keep." : ""}${sameDayNote}`
    const links: ProposalLink[] = [...(meeting.id ? [{ title: meeting.title, url: meetingPath(meeting.id) }] : []), ...(file ? [{ title: file.filename, url: `/api/admin/jack/files/${file.id}` }] : [])]

    return {
      before,
      ...(targetId ? { targetId } : {}),
      ...(file?.sha256 ? { fileSha256: file.sha256 } : {}),
      view: { title, summary, diff, ...(rows.length ? { rows } : {}), ...(links.length ? { links } : {}), ...(people.size ? { people: [...people.values()] } : {}) },
    }
  },

  // The meeting's own fields are checked under its row lock in apply (updateMeetingTx's expected), a new one's title and day under a lock too
  async checkStale() {
    return null
  },

  async apply(p, ctx) {
    const was = recordBefore.safeParse(ctx.before)
    if (!was.success) throw new StaleProposalError("The proposal's copy of the meeting is missing. Ask Jack to propose it again.")
    const picked = (id: string) => !ctx.selectedRows || ctx.selectedRows.includes(id)
    const decisions = (p.decisions ?? []).map((d, i) => ({ ...d, rowId: decisionRowId(i) })).filter((d) => picked(d.rowId))
    const items = (p.actionItems ?? []).map((item, i) => ({ ...item, rowId: itemRowId(i) })).filter((item) => picked(item.rowId))
    const meetingPicked = picked(MEETING_ROW)
    if (!was.data.meetingId && !meetingPicked) throw new Error(`Keep “Meeting: ${p.title ?? "the meeting"}” picked: its decisions and action items need it. Ask Jack to propose it again.`)
    let owners: Map<string, OfficerRef>
    try {
      owners = await resolveOfficers(
        items.map((item) => item.owner),
        "An action item's owner",
      )
    } catch (error) {
      throw new StaleProposalError(error instanceof Error ? error.message : String(error))
    }
    const actor = { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata }
    // Read before anything is written: where the decisions came from, for their decision-log entries
    const provenance = decisions.length ? await proposalProvenance(ctx, p.fileId, new Date()) : undefined

    const written = await prisma.$transaction(
      async (tx) => {
        let meeting: Meeting
        let created = false
        let changed = false
        if (was.data.meetingId) {
          // Only what differed when proposed (a field that matched then is left as it is now), and only with the meeting's row picked
          const own = meetingPicked ? was.data.fields : {}
          const proposedHeldAt = typeof own.heldAt === "string" ? new Date(own.heldAt) : undefined
          const changes = Object.fromEntries(Object.entries(payloadFields(p, proposedHeldAt)).filter(([key]) => key in own))
          const result = await updateMeetingTx(tx, was.data.meetingId, changes, actor, {
            ...("transcriptFileId" in own && p.fileId ? { transcriptFileId: p.fileId } : {}),
            expected: own,
          })
          if (!result.ok) {
            if (result.reason === "changed") throw new StaleProposalError("Someone changed the meeting since this was proposed.")
            if (result.reason === "not_found") throw new StaleProposalError("The meeting was deleted since this was proposed.")
            throw new Error(result.error)
          }
          meeting = result.meeting
          changed = result.changed.length > 0
        } else {
          const fields = payloadFields(p)
          const parsed = meetingFieldsSchema.safeParse(fields)
          if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the meeting's fields.")
          // One apply at a time per title and day, then the same check as when proposed
          await lockMeetingDayTx(tx, parsed.data.title, parsed.data.heldAt)
          const same = (await meetingsOnDay(tx, parsed.data.heldAt)).find((other) => sameMeetingTitle(other.title, parsed.data.title))
          if (same) throw new StaleProposalError(`“${same.title}” on ${cardDay(same.heldAt)} is already recorded. Ask Jack to add to it instead.`)
          const result = await createMeetingTx(tx, fields, actor, { transcriptFileId: p.fileId ?? null, roomId: ctx.roomId })
          if (!result.ok) throw new Error(result.error)
          meeting = result.meeting
          created = true
        }

        // Leave out what the meeting already has (from another proposal, or twice in this one)
        const has = created ? { decisions: new Set<string>(), actionItems: new Set<string>() } : await meetingTextKeysTx(tx, meeting.id)
        const newDecisions = decisions.filter((d) => isNew(has.decisions, d.text))
        const newItems = items.filter((item) => isNew(has.actionItems, item.text))
        if (!created && !changed && !newDecisions.length && !newItems.length) {
          throw new StaleProposalError(`“${meeting.title}” already has ${decisions.length && items.length ? "these decisions and action items" : decisions.length ? (decisions.length === 1 ? "this decision" : "these decisions") : items.length === 1 ? "this action item" : "these action items"}.`)
        }

        const rows = await createDecisionsTx(tx, meeting, newDecisions.map((d) => ({ text: d.text, title: d.title ?? null })), actor)
        const itemIds: { rowId: string; id: string }[] = []
        for (const item of newItems) {
          const result = await createActionItemTx(tx, { text: item.text, ownerId: officerFor(owners, item.owner)?.id ?? null, dueAt: item.due ? dueDateValue(item.due) : null }, actor, { meetingId: meeting.id, roomId: ctx.roomId })
          if (!result.ok) throw result.reason === "owner" ? new StaleProposalError(`${item.owner ? `@${item.owner.replace(/^@/, "")}` : "An owner"} isn't an officer anymore.`) : new Error(result.error)
          itemIds.push({ rowId: item.rowId, id: result.item.id })
        }
        return { meeting, created, changed, decisions: rows, decisionInputs: newDecisions, itemIds, skipped: { decisions: decisions.length - newDecisions.length, actionItems: items.length - newItems.length } }
      },
      { timeout: 30_000 },
    )

    // The decision log, after the meeting is saved: each through the knowledge service, as Jack's
    const logged = await linkDecisionsToLog(
      written.meeting,
      written.decisions.map((decision, i) => ({ decision, title: written.decisionInputs[i]?.title ?? null })),
      actor,
      { roomId: ctx.roomId, ...(provenance ? { provenance } : {}) },
    )
    const failed = logged.filter((r) => !r.knowledge.ok)
    revalidateQuietly([...meetingPaths(written.meeting.id), "/admin/knowledge"])

    const parts = [written.decisions.length ? plural(written.decisions.length, "decision") : null, written.itemIds.length ? plural(written.itemIds.length, "action item") : null].filter(Boolean)
    const what = `${written.created ? "Recorded" : "Updated"} “${written.meeting.title}” (${cardDay(written.meeting.heldAt)})${parts.length ? ` with ${parts.join(" and ")}` : ""}.`
    const skipped = [written.skipped.decisions ? plural(written.skipped.decisions, "decision") : null, written.skipped.actionItems ? plural(written.skipped.actionItems, "action item") : null].filter(Boolean)
    const repeats = skipped.length ? ` Left out ${skipped.join(" and ")} the meeting already had.` : ""
    const missing = failed.length ? ` ${plural(failed.length, "decision")} couldn't go to the decision log (${failed[0].knowledge.ok ? "" : failed[0].knowledge.error}); add ${failed.length === 1 ? "it" : "them"} on the Knowledge page.` : ""
    return {
      summary: `${what}${repeats}${missing}`,
      links: [
        { title: written.meeting.title, url: meetingPath(written.meeting.id) },
        ...(written.meeting.agendaMd ? [{ title: "Agenda", url: meetingAgendaPath(written.meeting.id) }] : []),
        ...(written.itemIds.length ? [{ title: "Action items", url: ACTION_ITEMS_PAGE }] : []),
      ],
      created: [
        ...(written.created ? [{ type: "MEETING", id: written.meeting.id }] : []),
        ...written.itemIds.map((item) => ({ type: "ACTION_ITEM", id: item.id })),
        ...logged.flatMap((r) => (r.knowledge.ok ? [{ type: "KNOWLEDGE_ENTRY", id: r.knowledge.entryId }] : [])),
      ],
      ...(ctx.selectedRows
        ? {
            appliedRows: [
              ...(meetingPicked && (written.created || written.changed) ? [MEETING_ROW] : []),
              ...written.decisionInputs.map((d) => d.rowId),
              ...written.itemIds.map((item) => item.rowId),
            ],
          }
        : {}),
      counts: {
        decisions: written.decisions.length,
        actionItems: written.itemIds.length,
        ...(skipped.length ? { alreadyThere: written.skipped.decisions + written.skipped.actionItems } : {}),
        ...(failed.length ? { notInDecisionLog: failed.length } : {}),
      },
    }
  },
}
