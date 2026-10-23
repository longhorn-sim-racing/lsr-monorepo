import type { ActionItem } from "@prisma/client"
import { z } from "zod"
import { ACTION_ITEM_STATUS_LABEL, ACTION_ITEM_STATUSES, ACTION_ITEMS_PAGE, dueDateValue, MEETING_LIMITS, meetingPath, type ActionItemStatus } from "@/lib/meetings"
import { ACTION_ITEM_FIELD_LABEL, actionItemChangesSchema, actionItemFieldsSchema, type ActionItemChanges } from "@/schemas/meeting.schema"
import { prisma } from "@/server/db"
import { actionItemPaths, createActionItemTx, fieldValue, updateActionItemTx } from "@/server/services/meeting.service"
import { userNames, type OfficerRef } from "@/server/services/officers"
import { centralDateInput } from "../../tools/time"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalDiffRow, ProposalKind, ProposalLink, ProposalRow } from "../types"
import { cardDay, clip, handleInput, idInput, officerFor, plural, resolveOfficers, revalidateQuietly } from "./shared"

/**
 * action_item.update (design §4.3, sponsors-meetings; on propose_change): mark action items done or
 * dropped, reopen them, reassign them, change their due dates or text, or add new ones, several at once.
 * Each item is a row on the card. The picked rows are checked at apply time: an item whose changed
 * fields moved on since makes the proposal stale, and they apply all or none, through the same service
 * as the Action items page.
 */

const itemInput = z.object({
  id: idInput.optional().describe("The action item's id from meetings_list. Leave out to add a new one"),
  text: z.string().trim().min(3).max(MEETING_LIMITS.actionItemMax).optional().describe("What needs doing (required for a new one)"),
  owner: handleInput.nullable().optional().describe("Handle of the officer who'll do it; null for nobody"),
  due: centralDateInput.nullable().optional().describe("Central due date, YYYY-MM-DD; null clears it"),
  status: z.enum(ACTION_ITEM_STATUSES).optional(),
  meetingId: idInput.optional().describe("A new item's meeting, from meetings_list"),
})

export const actionItemUpdateSchema = z.object({
  items: z
    .array(itemInput)
    .min(1)
    .max(50)
    .superRefine((rows, ctx) => {
      const seen = new Set<string>()
      rows.forEach((row, i) => {
        if (!row.id) {
          if (!row.text) ctx.addIssue({ code: "custom", path: [i, "text"], message: "a new action item needs its text" })
          return
        }
        if (seen.has(row.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "the same item is in two rows; put its changes in one" })
        seen.add(row.id)
        if (row.meetingId) ctx.addIssue({ code: "custom", path: [i, "meetingId"], message: "an existing item keeps its meeting" })
        if ([row.text, row.owner, row.due, row.status].every((v) => v === undefined)) ctx.addIssue({ code: "custom", path: [i], message: "nothing to change" })
      })
    }),
})

export type ActionItemUpdate = z.infer<typeof actionItemUpdateSchema>
type ItemInput = z.infer<typeof itemInput>

const rowBefore = z.union([
  z.object({ action: z.literal("create") }),
  z.object({ action: z.literal("update"), itemId: z.string(), text: z.string(), fields: z.record(z.string(), z.string().nullable()) }),
])
const updateBefore = z.object({ rows: z.record(z.string(), rowBefore) })

const rowId = (i: number) => `i${i + 1}`

/** A row's changes as the service takes them (owner handle to id, due date to the start of that Central day), only the ones given */
function rowChanges(row: ItemInput, owners: Map<string, OfficerRef>, label: string): ActionItemChanges {
  const changes: Record<string, unknown> = {}
  if (row.text !== undefined) changes.text = row.text
  if (row.owner !== undefined) changes.ownerId = row.owner === null ? null : (officerFor(owners, row.owner)?.id ?? null)
  if (row.due !== undefined) changes.dueAt = row.due === null ? null : dueDateValue(row.due)
  if (row.status !== undefined) changes.status = row.status
  const parsed = actionItemChangesSchema.safeParse(changes)
  if (!parsed.success) throw new ProposalInputError(`${label}: ${parsed.error.issues[0]?.message ?? "check it"}`)
  return parsed.data
}

function show(key: keyof ActionItemChanges, value: unknown, names: Map<string, OfficerRef>): string | null {
  if (value === null || value === undefined) return null
  if (key === "ownerId") return names.get(String(value))?.displayName ?? "Former officer"
  if (key === "dueAt") return cardDay(value as Date)
  if (key === "status") return ACTION_ITEM_STATUS_LABEL[value as ActionItemStatus] ?? String(value)
  return String(value)
}

function changedKeys(item: ActionItem, changes: ActionItemChanges): (keyof ActionItemChanges)[] {
  return (Object.keys(changes) as (keyof ActionItemChanges)[]).filter((key) => changes[key] !== undefined && fieldValue(changes[key]) !== fieldValue(item[key]))
}

/** "Mark “Send the packet” done", "Reassign “Book the room”", "Update the action item “…”" */
function singleTitle(item: ActionItem, keys: (keyof ActionItemChanges)[], changes: ActionItemChanges): string {
  const name = `“${clip(item.text, 60)}”`
  if (keys.length === 1 && keys[0] === "status") return changes.status === "done" ? `Mark ${name} done` : changes.status === "dropped" ? `Drop ${name}` : `Reopen ${name}`
  if (keys.length === 1 && keys[0] === "ownerId") return `Reassign ${name}`
  if (keys.length === 1 && keys[0] === "dueAt") return `Change the due date of ${name}`
  return `Update the action item ${name}`
}

export const actionItemUpdateKind: ProposalKind<ActionItemUpdate> = {
  kind: "action_item.update",
  tool: "propose_change",
  description:
    "action_item.update: change action items (ids from meetings_list): mark done or dropped, reopen, reassign (owner handle), change the due date or text; or add new ones (no id), optionally on a meeting. Several at once.",
  schema: actionItemUpdateSchema,
  targetType: "ACTION_ITEM",
  permission: "officer",

  async prepare(p) {
    const owners = await resolveOfficers(
      p.items.map((row) => row.owner),
      "An action item's owner",
    )
    const ids = p.items.map((row) => row.id).filter((id): id is string => Boolean(id))
    const existing = ids.length ? await prisma.actionItem.findMany({ where: { id: { in: ids } } }) : []
    const byId = new Map(existing.map((item) => [item.id, item]))
    const missing = ids.filter((id) => !byId.has(id))
    if (missing.length) throw new ProposalInputError(`There's no action item with id ${missing.join(", ")}. Get ids from meetings_list (show: action_items).`)
    const meetingIds = [...new Set(p.items.map((row) => row.meetingId).filter((id): id is string => Boolean(id)))]
    const meetings = meetingIds.length ? await prisma.meeting.findMany({ where: { id: { in: meetingIds } }, select: { id: true, title: true } }) : []
    const unknownMeeting = meetingIds.find((id) => !meetings.some((m) => m.id === id))
    if (unknownMeeting) throw new ProposalInputError(`There's no meeting with id ${unknownMeeting}. Find it with meetings_list.`)
    const names = await userNames([...[...owners.values()].map((o) => o.id), ...existing.map((item) => item.ownerId)])

    const rows: ProposalRow[] = []
    const diff: ProposalDiffRow[] = []
    const before: z.infer<typeof updateBefore> = { rows: {} }
    let creates = 0
    let single = ""
    for (const [i, row] of p.items.entries()) {
      const id = rowId(i)
      const changes = rowChanges(row, owners, `Item ${i + 1}`)
      if (!row.id) {
        const parsed = actionItemFieldsSchema.safeParse({ text: changes.text, ownerId: changes.ownerId ?? null, dueAt: changes.dueAt ?? null })
        if (!parsed.success) throw new ProposalInputError(`Item ${i + 1}: ${parsed.error.issues[0]?.message ?? "check it"}`)
        if (row.status && row.status !== "open") throw new ProposalInputError(`Item ${i + 1}: a new action item starts open.`)
        const meeting = meetings.find((m) => m.id === row.meetingId)
        creates += 1
        rows.push({
          id,
          label: clip(parsed.data.text, 120),
          detail: ["New", show("ownerId", parsed.data.ownerId, names) ?? "no owner", parsed.data.dueAt ? `due ${cardDay(parsed.data.dueAt)}` : "no due date", meeting ? `from ${meeting.title}` : null].filter(Boolean).join(" · "),
        })
        before.rows[id] = { action: "create" }
        single = `Add the action item “${clip(parsed.data.text, 60)}”`
        continue
      }
      const item = byId.get(row.id)!
      const keys = changedKeys(item, changes)
      if (!keys.length) throw new ProposalInputError(`Item ${i + 1}: nothing would change for “${clip(item.text, 60)}”.`)
      rows.push({
        id,
        label: clip(item.text, 120),
        detail: keys.map((key) => `${ACTION_ITEM_FIELD_LABEL[key]}: ${clip(show(key, item[key], names) ?? "none", 50)} → ${clip(show(key, changes[key], names) ?? "none", 50)}`).join("; "),
      })
      for (const key of keys) diff.push({ field: `${id}.${key}`, label: `${clip(item.text, 40)}: ${ACTION_ITEM_FIELD_LABEL[key]}`, before: show(key, item[key], names), after: show(key, changes[key], names), format: key === "text" ? "text" : "value" })
      before.rows[id] = { action: "update", itemId: item.id, text: item.text, fields: Object.fromEntries(keys.map((key) => [key, fieldValue(item[key])])) }
      single = singleTitle(item, keys, changes)
    }

    const updates = p.items.length - creates
    const title = p.items.length === 1 ? single : !creates ? `Update ${plural(updates, "action item")}` : !updates ? `Add ${plural(creates, "action item")}` : `Add ${plural(creates, "action item")} and update ${updates}`
    const onlyUpdate = p.items.length === 1 && p.items[0].id ? p.items[0].id : null
    const firstMeeting = existing[0]?.meetingId ?? meetings[0]?.id ?? null
    const links: ProposalLink[] = [{ title: "Action items", url: ACTION_ITEMS_PAGE }, ...(p.items.length === 1 && firstMeeting ? [{ title: "Its meeting", url: meetingPath(firstMeeting) }] : [])]
    return {
      before,
      ...(onlyUpdate ? { targetId: onlyUpdate } : {}),
      view: {
        title,
        summary: `Applying it ${[creates ? `adds ${plural(creates, "action item")}` : null, updates ? `changes ${plural(updates, "action item")} as shown` : null].filter(Boolean).join(" and ")} on the Action items page.${p.items.length > 1 ? " Pick which ones to apply." : ""}`,
        diff,
        rows,
        links,
      },
    }
  },

  // The picked rows are checked in apply, so a change to an item an officer left out doesn't block the rest
  async checkStale() {
    return null
  },

  async apply(p, ctx) {
    const was = updateBefore.safeParse(ctx.before)
    if (!was.success) throw new StaleProposalError("The proposal's copy of the action items is missing. Ask Jack to propose it again.")
    let owners: Map<string, OfficerRef>
    try {
      owners = await resolveOfficers(
        p.items.map((row) => row.owner),
        "An action item's owner",
      )
    } catch (error) {
      throw new StaleProposalError(error instanceof Error ? error.message : String(error))
    }
    const picked = new Set(ctx.selectedRows ?? p.items.map((_, i) => rowId(i)))
    const actor = { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata }

    const done = await prisma.$transaction(
      async (tx) => {
        const applied: { rowId: string; id: string; meetingId: string | null; created: boolean; status: string }[] = []
        for (const [i, row] of p.items.entries()) {
          const id = rowId(i)
          const planned = was.data.rows[id]
          if (!picked.has(id) || !planned) continue
          const changes = rowChanges(row, owners, `Item ${i + 1}`)
          if (planned.action === "create") {
            const result = await createActionItemTx(tx, { text: changes.text, ownerId: changes.ownerId ?? null, dueAt: changes.dueAt ?? null }, actor, { meetingId: row.meetingId ?? null, roomId: ctx.roomId })
            if (!result.ok) throw result.reason === "owner" ? new StaleProposalError(`Item ${i + 1}'s owner isn't an officer anymore.`) : new Error(`Item ${i + 1}: ${result.error}`)
            applied.push({ rowId: id, id: result.item.id, meetingId: result.item.meetingId, created: true, status: result.item.status })
            continue
          }
          const only = Object.fromEntries(Object.keys(planned.fields).map((key) => [key, changes[key as keyof ActionItemChanges]]))
          const result = await updateActionItemTx(tx, planned.itemId, only, actor, { expected: planned.fields })
          if (!result.ok) {
            if (result.reason === "changed") throw new StaleProposalError(`“${clip(planned.text, 60)}” changed since this was proposed.`)
            if (result.reason === "not_found") throw new StaleProposalError(`“${clip(planned.text, 60)}” was deleted since this was proposed.`)
            if (result.reason === "owner") throw new StaleProposalError(`Item ${i + 1}'s new owner isn't an officer anymore.`)
            throw new Error(`Item ${i + 1}: ${result.error}`)
          }
          applied.push({ rowId: id, id: result.item.id, meetingId: result.item.meetingId, created: false, status: result.item.status })
        }
        return applied
      },
      { timeout: 30_000 },
    )

    revalidateQuietly(done.flatMap((row) => actionItemPaths(row.meetingId)))
    const created = done.filter((row) => row.created)
    const updated = done.filter((row) => !row.created)
    const closed = updated.filter((row) => row.status === "done").length
    const summary = [
      created.length ? `Added ${plural(created.length, "action item")}` : null,
      updated.length ? `${created.length ? "updated" : "Updated"} ${plural(updated.length, "action item")}${closed ? ` (${closed} marked done)` : ""}` : null,
    ]
      .filter(Boolean)
      .join(" and ")
    return {
      summary: `${summary}.`,
      links: [{ title: "Action items", url: ACTION_ITEMS_PAGE }],
      created: created.map((row) => ({ type: "ACTION_ITEM", id: row.id })),
      appliedRows: done.map((row) => row.rowId),
      counts: { added: created.length, updated: updated.length },
    }
  },
}
