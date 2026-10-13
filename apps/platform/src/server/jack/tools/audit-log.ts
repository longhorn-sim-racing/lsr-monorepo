import type { Prisma } from "@prisma/client"
import { z } from "zod"
import { prisma } from "@/server/db"
import { forModelWithList, plural, tableDisplay } from "./display"
import { centralDateInput, centralRange, ct, ctShort } from "./time"
import type { JackTool } from "./types"

/**
 * audit_log: recent admin changes and payment events, filtered (#161). Before/after JSON is left out
 * to keep it small; run_sql can read it for one entry.
 */

const insensitive = (value: string) => ({ equals: value.trim(), mode: "insensitive" as const })
const contains = (value: string) => ({ contains: value.trim(), mode: "insensitive" as const })

export function auditWhere(filters: { start: Date; end: Date; action?: string; entity?: string; actor?: string; search?: string }): Prisma.AuditLogWhereInput {
  const { start, end, action, entity, actor, search } = filters
  return {
    createdAt: { gte: start, lte: end },
    ...(action ? { actionType: insensitive(action) } : {}),
    ...(entity ? { entityType: insensitive(entity) } : {}),
    ...(actor
      ? actor.trim().toLowerCase() === "system"
        ? { actorUserId: null }
        : { actor: { OR: [{ displayName: contains(actor) }, { handle: contains(actor) }, { email: contains(actor) }] } }
      : {}),
    ...(search ? { summary: contains(search) } : {}),
  }
}

const input = z.object({
  from: centralDateInput.optional().describe("First Central date (default: 7 days ago)"),
  to: centralDateInput.optional().describe("Last Central date (default: today)"),
  action: z.string().max(60).optional().describe("An actionType, e.g. CREATE, UPDATE, DELETE, PAYMENT_SUCCEEDED, PAYMENT_EXPIRED, LEAGUE_ENTRY_GRANTED"),
  entity: z.string().max(60).optional().describe("An entityType, e.g. EVENT, PAYMENT, USER, SEASON, Entitlement, LeagueApplication"),
  actor: z.string().max(80).optional().describe('Who did it: part of a name, handle or email, or "system" for automatic entries (webhooks, jobs)'),
  search: z.string().max(80).optional().describe("Words in the summary"),
  limit: z.number().int().min(1).max(100).default(30),
})

export const auditLogTool: JackTool<z.infer<typeof input>> = {
  name: "audit_log",
  description:
    "Recent entries from the audit log (admin changes, payments, entries, uploads), newest first, with who did it, the action, what it touched and a summary, plus counts by action for the same filters. Use it for 'who changed X', 'what happened this week', 'when were standings recomputed'.",
  input,
  async run({ from, to, action, entity, actor, search, limit }) {
    const range = centralRange({ from, to }, { fromDaysAgo: 7, toDaysAhead: 0 })
    if (!range.ok) return { isError: true, forModel: range.error, label: "Audit log lookup failed", displays: [] }
    const where = auditWhere({ start: range.start, end: range.end, action, entity, actor, search })

    const [total, byAction, entries] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.groupBy({ by: ["actionType"], where, _count: { _all: true }, orderBy: { _count: { actionType: "desc" } } }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          createdAt: true,
          actionType: true,
          entityType: true,
          entityId: true,
          summary: true,
          actor: { select: { displayName: true, handle: true } },
          targetUser: { select: { displayName: true, email: true } },
        },
      }),
    ])

    const rows = entries.map((e) => ({
      at: ct(e.createdAt),
      by: e.actor ? `${e.actor.displayName} (@${e.actor.handle})` : "system",
      action: e.actionType,
      entity: `${e.entityType} ${e.entityId}`,
      target: e.targetUser ? `${e.targetUser.displayName} <${e.targetUser.email}>` : null,
      summary: e.summary,
    }))
    const result = {
      range: { from: range.from, to: range.to, timeZone: "America/Chicago" },
      total,
      shown: rows.length,
      byAction: byAction.map((a) => ({ action: a.actionType, count: a._count._all })),
      entries: rows,
    }

    return {
      forModel: forModelWithList(result, "entries", rows),
      label: `Read the audit log (${plural(total, "entry", "entries")}, ${range.from} to ${range.to})`,
      displays: [
        entries.length
          ? tableDisplay(entries, [
              { header: "When (CT)", value: (e) => ctShort(e.createdAt) },
              { header: "Who", value: (e) => e.actor?.displayName ?? "system" },
              { header: "Action", value: (e) => e.actionType },
              { header: "Summary", value: (e) => e.summary },
            ])
          : { kind: "note", text: "No audit entries match." },
      ],
    }
  },
}
