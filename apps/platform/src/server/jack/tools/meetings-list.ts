import type { Prisma } from "@prisma/client"
import { z } from "zod"
import { knowledgeEntryPath } from "@/lib/jack/knowledge"
import type { JackToolDisplay } from "@/lib/jack/parts"
import { ACTION_ITEM_STATUS_LABEL, ACTION_ITEMS_PAGE, centralDay, daysOverdue, formatMeetingTime, MEETING_TYPES, meetingAgendaPath, meetingPath, meetingTypeLabel, type ActionItemStatus, weekdayDate as ctDay } from "@/lib/meetings"
import { prisma } from "@/server/db"
import { getMeetingDetail, listActionItems, listDecisions, listMeetings, searchWords, type ActionItemRow } from "@/server/queries/meetings"
import { cleanHandle } from "@/server/services/officers"
import { forModelWithLists, plural, tableDisplay } from "./display"
import { centralDateInput, centralRange } from "./time"
import type { JackTool } from "./types"

/**
 * meetings_list (#188, design §7.1): club meetings, the decisions made at them and their action items.
 * Deferred (tool search). One meeting in full with meetingId; decisions and action items across
 * meetings with show. The decision log in Knowledge holds the same decisions (search finds them too).
 */

/** Most of an agenda or summary sent in one result; the meeting page has the rest */
const TEXT_CHARS = 6_000

const input = z.object({
  show: z.enum(["meetings", "decisions", "action_items"]).default("meetings").describe("What to list"),
  meetingId: z.string().trim().min(1).max(64).optional().describe("One meeting in full: agenda, summary, decisions and action items"),
  query: z.string().trim().min(1).max(100).optional().describe("Words in a meeting's title, agenda or summary, a decision, or an action item"),
  type: z.enum(MEETING_TYPES).optional().describe("Only this type of meeting"),
  from: centralDateInput.optional().describe("Central date, YYYY-MM-DD: meetings held (decisions made, items due) on or after it"),
  to: centralDateInput.optional(),
  owner: z.string().trim().min(1).max(80).optional().describe("action_items: only this officer's, by handle. For \"mine\", the asking officer's handle (only when one officer asked in this turn)"),
  status: z.enum(["open", "overdue", "done", "dropped", "all"]).default("open").describe("action_items: which (overdue = open and past its due date)"),
  limit: z.number().int().min(1).max(200).default(30),
})

type Input = z.infer<typeof input>

const words = searchWords
const insensitive = (word: string) => ({ contains: word, mode: "insensitive" as const })

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** An action item for the model */
function itemForModel(item: ActionItemRow, now: Date) {
  return {
    id: item.id,
    text: item.text,
    owner: item.owner ? `${item.owner.displayName} (@${item.owner.handle})` : null,
    status: item.status,
    ...(item.dueAt ? { due: ctDay(item.dueAt) } : {}),
    ...(item.overdue ? { overdue: true, daysOverdue: daysOverdue(item, now) } : {}),
    ...(item.doneAt ? { done: ctDay(item.doneAt) } : {}),
    ...(item.meeting ? { meeting: item.meeting.title, meetingLink: meetingPath(item.meeting.id) } : {}),
  }
}

async function oneMeeting(meetingId: string, now: Date) {
  const detail = await getMeetingDetail(meetingId, now)
  if (!detail) return { isError: true, forModel: `There's no meeting with id ${meetingId}. Call meetings_list without meetingId to list them.`, label: "Meeting not found", displays: [] }
  const { meeting } = detail
  const cut = (text: string | null) => (text && text.length > TEXT_CHARS ? { text: text.slice(0, TEXT_CHARS), note: `Cut at ${TEXT_CHARS.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters; the meeting page has it all.` } : text)
  const result = {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      type: meeting.kind,
      when: formatMeetingTime(meeting.heldAt),
      agenda: cut(meeting.agendaMd),
      summary: cut(meeting.summaryMd),
      ...(detail.transcript ? { transcript: detail.transcript.filename } : {}),
      link: meetingPath(meeting.id),
      ...(meeting.agendaMd ? { agendaPage: meetingAgendaPath(meeting.id) } : {}),
    },
    decisions: detail.decisions.map((d) => ({ text: d.text, ...(d.knowledge ? { decisionLog: knowledgeEntryPath(d.knowledge.id) } : {}) })),
  }
  const displays: JackToolDisplay[] = [
    { kind: "links", items: [{ title: meeting.title, url: meetingPath(meeting.id), meta: `${meetingTypeLabel(meeting.kind)} · ${formatMeetingTime(meeting.heldAt)}` }] },
    ...(detail.actionItems.length
      ? [
          tableDisplay(
            detail.actionItems,
            [
              { header: "Action item", value: (item: ActionItemRow) => item.text },
              { header: "Owner", value: (item: ActionItemRow) => item.owner?.displayName ?? null },
              { header: "Due", value: (item: ActionItemRow) => (item.dueAt ? ctDay(item.dueAt) : null) },
              { header: "Status", value: (item: ActionItemRow) => (item.overdue ? "Overdue" : ACTION_ITEM_STATUS_LABEL[item.status as ActionItemStatus]) },
            ],
            "Action items",
          ),
        ]
      : []),
  ]
  return {
    forModel: forModelWithLists(result, [{ key: "actionItems", items: detail.actionItems.map((item) => itemForModel(item, now)) }]),
    label: `Looked at the meeting “${meeting.title}”`,
    displays,
  }
}

async function meetings({ query, type, limit }: Input, range: { start?: Date; end?: Date }) {
  const rows = await listMeetings({ kind: type, from: range.start, to: range.end, query }, 500)
  const listed = rows.slice(0, limit)
  const items = listed.map((m) => ({ id: m.id, title: m.title, type: m.kind, when: formatMeetingTime(m.heldAt), agenda: m.hasAgenda, summary: m.hasSummary, decisions: m.decisions, actionItems: m.actionItems, openActionItems: m.openItems, link: meetingPath(m.id) }))
  const displays: JackToolDisplay[] = [
    listed.length
      ? tableDisplay(
          listed,
          [
            { header: "Meeting", value: (m) => m.title },
            { header: "Type", value: (m) => meetingTypeLabel(m.kind) },
            { header: "When", value: (m) => ctDay(m.heldAt) },
            { header: "Decisions", value: (m) => m.decisions },
            { header: "Open items", value: (m) => m.openItems },
          ],
          rows.length > listed.length ? `${listed.length} of ${rows.length}` : undefined,
        )
      : { kind: "note", text: "No meetings match." },
  ]
  return {
    forModel: forModelWithLists({ matching: rows.length, page: "/admin/meetings" }, [{ key: "meetings", items, whenTrimmed: "Narrow by date, type or words." }]),
    label: `Looked at meetings (${plural(rows.length, "match", "matches")})`,
    displays,
  }
}

async function decisions({ query, type, limit }: Input, range: { start?: Date; end?: Date }) {
  const terms = words(query)
  const base: Prisma.MeetingDecisionWhereInput = {
    ...(type ? { meeting: { kind: type } } : {}),
    ...(range.start ? { decidedAt: { gte: range.start, lte: range.end } } : {}),
  }
  let rows = await listDecisions(terms.length ? { ...base, AND: terms.map((w) => ({ text: insensitive(w) })) } : base, limit)
  // Nothing with every word: those with any of them, said so
  let some = false
  if (!rows.length && terms.length > 1) {
    rows = await listDecisions({ ...base, OR: terms.map((w) => ({ text: insensitive(w) })) }, limit)
    some = rows.length > 0
  }
  const items = rows.map((d) => ({
    text: d.text,
    decided: ctDay(d.decidedAt),
    ...(d.meeting ? { meeting: d.meeting.title, meetingLink: meetingPath(d.meeting.id) } : {}),
    ...(d.knowledge ? { decisionLog: knowledgeEntryPath(d.knowledge.id), ...(d.knowledge.archived ? { archived: true } : {}) } : {}),
  }))
  const displays: JackToolDisplay[] = [
    rows.length
      ? { kind: "links", items: rows.slice(0, 20).map((d) => ({ title: clip(d.text, 140), url: d.meeting ? meetingPath(d.meeting.id) : d.knowledge ? knowledgeEntryPath(d.knowledge.id) : "/admin/meetings", meta: [d.meeting?.title, ctDay(d.decidedAt)].filter(Boolean).join(" · ") })), caption: "Decisions" }
      : { kind: "note", text: "No decisions match." },
  ]
  return {
    forModel: forModelWithLists({ ...(some ? { note: "No decision has every word; these have some of them." } : {}), found: rows.length }, [{ key: "decisions", items }]),
    label: `Looked at decisions (${plural(rows.length, "match", "matches")})`,
    displays,
  }
}

async function actionItems({ query, owner, status, limit, from, to }: Input, now: Date) {
  let ownerId: string | undefined
  if (owner) {
    const user = await prisma.user.findUnique({ where: { handle: cleanHandle(owner) }, select: { id: true } })
    if (!user) return { isError: true, forModel: `No one has the handle @${cleanHandle(owner)}. Get officers' handles from club_members.`, label: "Action item lookup failed", displays: [] }
    ownerId = user.id
  }
  const terms = words(query)
  const all = await listActionItems({ status, ...(ownerId ? { ownerId } : {}) }, now)
  const matching = all.filter((item) => terms.every((w) => item.text.toLowerCase().includes(w)) && (!from || (item.dueAt !== null && centralDay(item.dueAt) >= from)) && (!to || (item.dueAt !== null && centralDay(item.dueAt) <= to)))
  const listed = matching.slice(0, limit)

  // Per owner, for "what's overdue for whom"
  const byOwner = new Map<string, { owner: string; open: number; overdue: number }>()
  for (const item of matching) {
    const key = item.owner?.id ?? "none"
    const row = byOwner.get(key) ?? { owner: item.owner ? `${item.owner.displayName} (@${item.owner.handle})` : "No owner", open: 0, overdue: 0 }
    if (item.status === "open") row.open += 1
    if (item.overdue) row.overdue += 1
    byOwner.set(key, row)
  }

  const displays: JackToolDisplay[] = [
    listed.length
      ? tableDisplay(
          listed,
          [
            { header: "Action item", value: (item) => item.text },
            { header: "Owner", value: (item) => item.owner?.displayName ?? null },
            { header: "Due", value: (item) => (item.dueAt ? ctDay(item.dueAt) : null) },
            { header: "Status", value: (item) => (item.overdue ? `Overdue ${daysOverdue(item, now)}d` : ACTION_ITEM_STATUS_LABEL[item.status as ActionItemStatus]) },
            { header: "Meeting", value: (item) => item.meeting?.title ?? null },
          ],
          matching.length > listed.length ? `${listed.length} of ${matching.length}` : undefined,
        )
      : { kind: "note", text: "No action items match." },
  ]
  return {
    forModel: forModelWithLists(
      {
        matching: matching.length,
        filters: { status, owner: owner ? `@${cleanHandle(owner)}` : null, query: query ?? null },
        definitions: "Overdue = open and due before today (Central). An item due today isn't overdue.",
        page: ACTION_ITEMS_PAGE,
      },
      [
        { key: "byOwner", items: [...byOwner.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open) },
        { key: "actionItems", items: listed.map((item) => itemForModel(item, now)), whenTrimmed: "Filter by owner or status, or lower the limit." },
      ],
    ),
    label: `Looked at action items (${plural(matching.length, "match", "matches")})`,
    displays,
  }
}

export const meetingsListTool: JackTool<Input> = {
  name: "meetings_list",
  description:
    "Club meetings (board, tech, general, department) with their agendas and summaries, the decisions made at them, and action items (owner, due date, open, done, dropped, overdue). show: meetings, decisions or action_items; meetingId gives one meeting in full. For \"what did we decide about X\", show decisions with a query (the decision log in Knowledge has them too).",
  input,
  deferred: true,
  async run(params) {
    const now = new Date()
    if (params.meetingId) return oneMeeting(params.meetingId, now)
    let range: { start?: Date; end?: Date } = {}
    if (params.from || params.to) {
      const window = centralRange({ from: params.from, to: params.to }, { fromDaysAgo: 3650, toDaysAhead: 3650 }, now)
      if (!window.ok) return { isError: true, forModel: window.error, label: "Meetings lookup failed", displays: [] }
      range = { start: window.start, end: window.end }
    }
    if (params.show === "decisions") return decisions(params, range)
    if (params.show === "action_items") return actionItems(params, now)
    return meetings(params, range)
  },
}
