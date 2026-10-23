import { prisma } from "@/server/db"
import { roundUsd } from "@/server/jack/cost"
import { chicagoMonth, getMonthSpend } from "@/server/jack/spend"
import { NAME_ROOM_JOB } from "@/server/jack/stand"

/**
 * The automation cap (design §1, principle 10): recurring questions and the weekly digest's Jack-written
 * summary share $10 a month inside Jack's $50, so they can't use up the officers' share. Automation
 * spend is what the Usage page counts as automation: replies to a scheduled note (each scheduled note
 * is answered in a reply of its own) plus Stand-style side jobs in JackUsage other than naming rooms.
 */

/** What automations may spend in a calendar month (Central Time): JACK_AUTOMATION_BUDGET_USD, default $10 */
export const DEFAULT_AUTOMATION_BUDGET_USD = 10

export function automationBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.JACK_AUTOMATION_BUDGET_USD?.trim()
  const value = raw ? Number(raw) : Number.NaN
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_AUTOMATION_BUDGET_USD
}

/** What automations cost in the Central Time month `now` falls in */
export async function automationSpendUsd(now = new Date()): Promise<number> {
  const { start, end } = chicagoMonth(now)
  const inMonth = { gte: start, lt: end }
  const [replies, sideJobs] = await Promise.all([
    prisma.jackMessage.aggregate({
      where: { kind: "assistant", costUsd: { not: null }, createdAt: inMonth, answers: { some: { kind: "system", scheduled: true } } },
      _sum: { costUsd: true },
    }),
    prisma.jackUsage.aggregate({ where: { createdAt: inMonth, job: { not: NAME_ROOM_JOB } }, _sum: { costUsd: true } }),
  ])
  return roundUsd(Number(replies._sum.costUsd ?? 0) + Number(sideJobs._sum.costUsd ?? 0))
}

export type AutomationBudget = {
  /** "October" */
  month: string
  spentUsd: number
  capUsd: number
  /** Jack's whole month, which automations count toward too */
  totalUsd: number
  budgetUsd: number
  /** Why an automation can't spend now, as a room note's reason, or null when it can */
  stopped: null | "automation_cap" | "monthly_budget"
}

/** Where automations stand this month against their cap and Jack's whole budget */
export async function automationBudget(now = new Date()): Promise<AutomationBudget> {
  const [spentUsd, month] = await Promise.all([automationSpendUsd(now), getMonthSpend(now)])
  const capUsd = automationBudgetUsd()
  const stopped = spentUsd >= capUsd ? "automation_cap" : month.totalUsd >= month.budgetUsd ? "monthly_budget" : null
  return { month: month.month, spentUsd, capUsd, totalUsd: month.totalUsd, budgetUsd: month.budgetUsd, stopped }
}
