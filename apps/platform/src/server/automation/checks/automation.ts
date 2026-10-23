import { recurringQuestionPath, RECURRING_PAGE } from "@/lib/jack/recurring"
import { formatUsd } from "@/lib/jack/spend"
import { prisma } from "@/server/db"
import { automationBudgetUsd, automationSpendUsd } from "../cap"
import type { DigestCheck } from "../types"

/** Digest and Overview "needs attention" checks from the automation track (design §11.2) */

/** Automation spend past this share of its cap needs attention (at the cap they stop) */
export const AUTOMATION_WARNING_RATIO = 0.8
const ITEMS = 5

/** Recurring questions and digest summaries are near their $10 cap this month, or reached it and stopped */
export const automationCap: DigestCheck = {
  id: "automation.cap",
  label: "Automations' monthly cap",
  href: "/admin/jack/usage",
  order: 97,
  async run({ now }) {
    const spent = await automationSpendUsd(now)
    const cap = automationBudgetUsd()
    const ratio = cap > 0 ? spent / cap : 1
    if (ratio < AUTOMATION_WARNING_RATIO) return { count: 0, severity: "info", items: [] }
    const reached = ratio >= 1
    return {
      count: 1,
      severity: reached ? "danger" : "warning",
      items: [
        {
          title: `Automations: ${formatUsd(spent)} of ${formatUsd(cap, { wholeIfRound: true })} this month`,
          href: RECURRING_PAGE,
          detail: reached ? "Recurring questions and digest summaries are skipped until the 1st" : `${Math.round(ratio * 100)}% of the cap`,
        },
      ],
    }
  },
}

/** Recurring questions a run paused by itself (their owner isn't an officer any more, their room was archived) */
export const pausedQuestions: DigestCheck = {
  id: "recurring.paused",
  label: "Recurring questions paused",
  href: RECURRING_PAGE,
  order: 98,
  async run() {
    const where = { pausedReason: { not: null }, scheduledJob: { enabled: false } }
    const [count, rows] = await Promise.all([
      prisma.recurringQuestion.count({ where }),
      prisma.recurringQuestion.findMany({ where, orderBy: { updatedAt: "desc" }, take: ITEMS, select: { id: true, title: true, pausedReason: true } }),
    ])
    return {
      count,
      severity: count ? "warning" : "info",
      items: rows.map((row) => ({ title: row.title, href: recurringQuestionPath(row.id), detail: `Paused: ${row.pausedReason}` })),
    }
  },
}

export const CHECKS: DigestCheck[] = [automationCap, pausedQuestions]
