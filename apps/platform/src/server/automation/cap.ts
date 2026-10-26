import type { Prisma } from "@prisma/client"
import type { JackSpend } from "@/lib/jack/spend"
import { recurringIdFromJobKey } from "@/lib/jack/recurring"
import { prisma } from "@/server/db"
import { roundUsd } from "@/server/jack/cost"
import { chicagoMonth, getMonthSpend } from "@/server/jack/spend"
import { NAME_ROOM_JOB } from "@/server/jack/stand"
import { typicalRunUsd } from "./recurring/estimate"

/**
 * The automation cap (design §1, principle 10): recurring questions and the weekly digest's Jack-written
 * summary share $10 a month inside Jack's $50, so they can't use up the officers' share. Automation
 * spend is what the Usage page counts as automation: replies to a scheduled note (each scheduled note
 * is answered in a reply of its own) plus Stand-style side jobs in JackUsage other than naming rooms.
 *
 * A run checks the cap and posts the note that starts its spend in one step (`withAutomationCap`): under
 * one lock, it counts what's spent plus what runs already started and haven't finished, and its note is
 * in before the lock is let go. Questions due in the same minute (each in its own invocation) take turns,
 * so only as many start as the cap has room for, instead of all of them reading the month before any
 * has spent.
 */

type Db = Prisma.TransactionClient | typeof prisma

/** What automations may spend in a calendar month (Central Time): JACK_AUTOMATION_BUDGET_USD, default $10 */
export const DEFAULT_AUTOMATION_BUDGET_USD = 10

export function automationBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.JACK_AUTOMATION_BUDGET_USD?.trim()
  const value = raw ? Number(raw) : Number.NaN
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_AUTOMATION_BUDGET_USD
}

/** What automations cost in the Central Time month `now` falls in */
export async function automationSpendUsd(now = new Date(), db: Db = prisma): Promise<number> {
  const { start, end } = chicagoMonth(now)
  const inMonth = { gte: start, lt: end }
  const [replies, sideJobs] = await Promise.all([
    db.jackMessage.aggregate({
      where: { kind: "assistant", costUsd: { not: null }, createdAt: inMonth, answers: { some: { kind: "system", scheduled: true } } },
      _sum: { costUsd: true },
    }),
    db.jackUsage.aggregate({ where: { createdAt: inMonth, job: { not: NAME_ROOM_JOB } }, _sum: { costUsd: true } }),
  ])
  return roundUsd(Number(replies._sum.costUsd ?? 0) + Number(sideJobs._sum.costUsd ?? 0))
}

const typicalRun = (persona: string | null | undefined) => typicalRunUsd(persona === "stand" ? "stand" : "jack")

/**
 * What runs already started will likely add, at a typical run's cost each (recurring/estimate.ts): a
 * scheduled note still waiting for its answer, and an answer to one still being written, less what that
 * answer has cost so far (already counted as spent). A waiting note counts however old it is: its job stops
 * looking after RETRY_WINDOW_MS, but the next reply in its room (a post, Continue) still answers it, as a
 * scheduled reply of its own that checks no cap, and that reply's cost lands in the month it's written. Only
 * a note in an archived room can't be answered. A digest summary is Jack's; a recurring question's is its
 * persona's
 */
export async function automationInFlightUsd(now = new Date(), db: Db = prisma): Promise<number> {
  const [waiting, answering] = await Promise.all([
    db.jackMessage.findMany({ where: { kind: "system", scheduled: true, answeredById: null, room: { archivedAt: null } }, select: { jobKey: true }, take: 500 }),
    db.jackMessage.findMany({
      where: { kind: "assistant", status: "streaming", createdAt: { gte: chicagoMonth(now).start }, answers: { some: { kind: "system", scheduled: true } } },
      select: { persona: true, costUsd: true },
      take: 500,
    }),
  ])
  const questionIds = [...new Set(waiting.flatMap((note) => recurringIdFromJobKey(note.jobKey) ?? []))]
  const questions = questionIds.length ? await db.recurringQuestion.findMany({ where: { id: { in: questionIds } }, select: { id: true, persona: true } }) : []
  const persona = new Map(questions.map((q) => [q.id, q.persona]))
  const notes = waiting.reduce((sum, note) => sum + typicalRun(persona.get(recurringIdFromJobKey(note.jobKey) ?? "")), 0)
  const replies = answering.reduce((sum, reply) => sum + Math.max(0, typicalRun(reply.persona) - Number(reply.costUsd ?? 0)), 0)
  return roundUsd(notes + replies)
}

export type AutomationBudget = {
  /** "October" */
  month: string
  spentUsd: number
  /** What runs already started and not finished will likely add (automationInFlightUsd) */
  reservedUsd: number
  capUsd: number
  /** Jack's whole month, which automations count toward too */
  totalUsd: number
  budgetUsd: number
  /** Why an automation can't spend now, as a room note's reason, or null when it can */
  stopped: null | "automation_cap" | "monthly_budget"
}

async function budgetFrom(now: Date, db: Db, month: JackSpend): Promise<AutomationBudget> {
  const [spentUsd, reservedUsd] = await Promise.all([automationSpendUsd(now, db), automationInFlightUsd(now, db)])
  const capUsd = automationBudgetUsd()
  const stopped = spentUsd + reservedUsd >= capUsd ? "automation_cap" : month.totalUsd + reservedUsd >= month.budgetUsd ? "monthly_budget" : null
  return { month: month.month, spentUsd, reservedUsd, capUsd, totalUsd: month.totalUsd, budgetUsd: month.budgetUsd, stopped }
}

/** " (counting the runs under way)" when those, not what's spent, take automations to their cap: for the notes that say so */
export function underWay(budget: AutomationBudget): string {
  return budget.stopped === "automation_cap" && budget.spentUsd < budget.capUsd ? " (counting the runs under way)" : ""
}

/** Where automations stand this month against their cap and Jack's whole budget, counting runs under way */
export async function automationBudget(now = new Date()): Promise<AutomationBudget> {
  return budgetFrom(now, prisma, await getMonthSpend(now))
}

/** What a run does once it holds the cap's lock: with where automations stand, post its note in `db` if there's room */
export type AutomationStart<T> = (budget: AutomationBudget, db: Prisma.TransactionClient) => Promise<T>
export type AutomationGate = <T>(now: Date, start: AutomationStart<T>) => Promise<T>

/** The advisory lock key automations take turns on */
export const CAP_LOCK = "jack:automation-cap"

/**
 * Checks the cap and starts a run in one step: `start` runs inside a transaction holding the cap's lock,
 * and the note it posts there counts as under way for the next run that takes the lock. Announce the note
 * after this returns (the transaction has committed then). Jack's whole month is read first, outside the
 * lock: officers' replies aren't reserved, so the lock adds nothing for it
 */
export const withAutomationCap: AutomationGate = async (now, start) => {
  const month = await getMonthSpend(now)
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CAP_LOCK}))`
      return start(await budgetFrom(now, tx, month), tx)
    },
    // Runs due together queue on the lock, each holding it for a few quick queries
    { maxWait: 10_000, timeout: 30_000 },
  )
}
