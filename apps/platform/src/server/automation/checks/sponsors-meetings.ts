import { ACTION_ITEMS_PAGE, centralDay, daysOverdue, isOverdue, ownerItemsPath } from "@/lib/meetings"
import { FOLLOW_UP_STAGES, isQuietProspect, lastTouch, prospectPath, QUIET_PROSPECT_DAYS, SPONSORS_PAGE, PROSPECT_STAGE_LABEL, type ProspectStage } from "@/lib/sponsor-prospects"
import { prisma } from "@/server/db"
import type { DigestCheck, DigestCheckResult, DigestItem } from "../types"

/** Digest and Overview "needs attention" checks from the sponsors-meetings track (design §11.2) */

/** Items each check lists; the count covers the rest */
const ITEMS = 8
/** An overdue item past this many days makes the check a warning */
const LATE_DAYS = 7

/**
 * Open action items past their due date (Central), per owner: "Dylan: 3 overdue". Names and counts
 * only, linking to that officer's items; the items' text stays in the console
 */
export const overdueActionItems: DigestCheck = {
  id: "action_items.overdue",
  label: "Overdue action items",
  href: `${ACTION_ITEMS_PAGE}?status=overdue`,
  order: 20,
  async run({ now }): Promise<DigestCheckResult> {
    // Due before the start of today's Central date (an item due today isn't overdue)
    const open = await prisma.actionItem.findMany({
      where: { status: "open", dueAt: { not: null, lt: now } },
      select: { status: true, dueAt: true, owner: { select: { displayName: true, handle: true } } },
    })
    const overdue = open.filter((item) => isOverdue(item, now))
    const byOwner = new Map<string, { title: string; href: string; count: number; oldest: number; oldestDue: Date }>()
    for (const item of overdue) {
      const key = item.owner?.handle ?? ""
      const days = daysOverdue(item, now)
      const row = byOwner.get(key) ?? { title: item.owner?.displayName ?? "No owner", href: item.owner ? `${ownerItemsPath(item.owner.handle)}&status=overdue` : `${ACTION_ITEMS_PAGE}?owner=none&status=overdue`, count: 0, oldest: 0, oldestDue: item.dueAt! }
      row.count += 1
      if (days > row.oldest) {
        row.oldest = days
        row.oldestDue = item.dueAt!
      }
      byOwner.set(key, row)
    }
    const groups = [...byOwner.values()].sort((a, b) => b.oldest - a.oldest || b.count - a.count)
    const items: DigestItem[] = groups.slice(0, ITEMS).map((g) => ({
      title: `${g.title}: ${g.count} overdue`,
      href: g.href,
      detail: `Oldest due ${centralDay(g.oldestDue)} (${g.oldest} ${g.oldest === 1 ? "day" : "days"} ago)`,
    }))
    // Items are owners, so "and N more" counts the owners left out
    return { count: overdue.length, severity: groups.some((g) => g.oldest > LATE_DAYS) ? "warning" : "info", items, moreItems: groups.length - items.length }
  },
}

/**
 * Sponsor prospects the club has reached out to (contacted or talking) with nothing logged for
 * QUIET_PROSPECT_DAYS: a follow-up is likely due. Company names and owners' handles only
 */
export const quietProspects: DigestCheck = {
  id: "sponsors.quiet",
  label: "Quiet sponsor prospects",
  href: `${SPONSORS_PAGE}?view=quiet`,
  order: 25,
  async run({ now }): Promise<DigestCheckResult> {
    const rows = await prisma.sponsorProspect.findMany({
      where: { stage: { in: [...FOLLOW_UP_STAGES] } },
      select: {
        id: true,
        company: true,
        stage: true,
        createdAt: true,
        lastContactAt: true,
        owner: { select: { handle: true } },
        activities: { orderBy: { occurredAt: "desc" }, take: 1, select: { occurredAt: true } },
      },
    })
    const quiet = rows
      .map((row) => ({ row, touch: { createdAt: row.createdAt, lastContactAt: row.lastContactAt, lastActivityAt: row.activities[0]?.occurredAt ?? null } }))
      .filter(({ row, touch }) => isQuietProspect({ stage: row.stage, ...touch }, now))
      .map(({ row, touch }) => ({ row, days: Math.floor((now.getTime() - lastTouch(touch).getTime()) / 86_400_000) }))
      .sort((a, b) => b.days - a.days)
    return {
      count: quiet.length,
      // Twice the quiet window and it's likely gone cold
      severity: quiet.some((q) => q.days >= QUIET_PROSPECT_DAYS * 2) ? "warning" : "info",
      items: quiet.slice(0, ITEMS).map(({ row, days }) => ({
        title: row.company,
        href: prospectPath(row.id),
        detail: `${PROSPECT_STAGE_LABEL[row.stage as ProspectStage] ?? row.stage}, nothing logged for ${days} days${row.owner ? ` · @${row.owner.handle}` : " · no owner"}`,
      })),
    }
  },
}

export const CHECKS: DigestCheck[] = [overdueActionItems, quietProspects]
