import { runsPerMonth, type RecurringPersona, type RecurringSchedule } from "@/lib/jack/recurring"
import { formatUsd } from "@/lib/jack/spend"
import { prisma } from "@/server/db"
import { costUsd, roundUsd, type TokenUsage } from "@/server/jack/cost"
import { JACK_MODELS } from "@/server/jack/models"

/**
 * A recurring question's estimated monthly cost (design §4.3, §13): about how many times a month it runs,
 * times what one run costs. One run's cost comes from the question's own last answers when it has some,
 * else from recent answers to any recurring question by the same persona, else from a typical run's
 * tokens at the model's prices. Shown on the proposal card and the Recurring questions page, labelled an
 * estimate.
 */

/**
 * A typical scheduled answer: the cached prompt written once (daily runs come long after the cache's five
 * minutes), read back on a few tool rounds, and a short answer with some thinking
 */
export const TYPICAL_RUN_TOKENS: TokenUsage = { inputTokens: 3_000, cacheWriteTokens: 30_000, cacheReadTokens: 90_000, outputTokens: 2_000 }

/** Answers averaged for a question's own estimate */
const OWN_SAMPLES = 5
/** Recent answers to any recurring question by a persona, needed before they're used instead of the typical run */
const PERSONA_MIN_SAMPLES = 3
const PERSONA_SAMPLES = 20
const PERSONA_WINDOW_DAYS = 60

export type RunEstimate = {
  perRunUsd: number
  /** Where the per-run figure came from */
  basis: "own" | "recent" | "typical"
}

export type MonthlyEstimate = RunEstimate & { runsPerMonth: number; monthlyUsd: number }

export function typicalRunUsd(persona: RecurringPersona): number {
  return costUsd(JACK_MODELS[persona].model, TYPICAL_RUN_TOKENS)
}

const average = (values: number[]) => roundUsd(values.reduce((sum, v) => sum + v, 0) / values.length)

/** What answers cost lately: per job key (each question's own), and per persona over every recurring question */
async function recentAnswerCosts(jobKeys: string[], now: Date): Promise<{ byKey: Map<string, number[]>; byPersona: Map<string, number[]> }> {
  const since = new Date(now.getTime() - PERSONA_WINDOW_DAYS * 86_400_000)
  const notes = await prisma.jackMessage.findMany({
    where: { kind: "system", scheduled: true, jobKey: { startsWith: "recurring:" }, answeredById: { not: null }, createdAt: { gte: since } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 500,
    select: { jobKey: true, answeredBy: { select: { persona: true, costUsd: true, status: true } } },
  })
  const byKey = new Map<string, number[]>()
  const byPersona = new Map<string, number[]>()
  const wanted = new Set(jobKeys)
  for (const note of notes) {
    const reply = note.answeredBy
    if (!reply || reply.costUsd === null || reply.status !== "done" || !reply.persona) continue
    const cost = Number(reply.costUsd)
    if (note.jobKey && wanted.has(note.jobKey)) {
      const own = byKey.get(note.jobKey) ?? []
      if (own.length < OWN_SAMPLES) byKey.set(note.jobKey, [...own, cost])
    }
    const persona = byPersona.get(reply.persona) ?? []
    if (persona.length < PERSONA_SAMPLES) byPersona.set(reply.persona, [...persona, cost])
  }
  return { byKey, byPersona }
}

/** Estimates for several questions at once (the page's list): by job key, for each one's persona and schedule */
export async function estimateMonthly(questions: { jobKey: string | null; persona: RecurringPersona; schedule: RecurringSchedule | null }[], now = new Date()): Promise<MonthlyEstimate[]> {
  const { byKey, byPersona } = await recentAnswerCosts(questions.flatMap((q) => (q.jobKey ? [q.jobKey] : [])), now)
  return questions.map((question) => {
    const own = question.jobKey ? byKey.get(question.jobKey) : undefined
    const recent = byPersona.get(question.persona)
    const run: RunEstimate = own?.length
      ? { perRunUsd: average(own), basis: "own" }
      : recent && recent.length >= PERSONA_MIN_SAMPLES
        ? { perRunUsd: average(recent), basis: "recent" }
        : { perRunUsd: typicalRunUsd(question.persona), basis: "typical" }
    const runs = question.schedule ? runsPerMonth(question.schedule) : 0
    return { ...run, runsPerMonth: runs, monthlyUsd: roundUsd(run.perRunUsd * runs) }
  })
}

/** One question's estimate */
export async function estimateOne(question: { jobKey: string | null; persona: RecurringPersona; schedule: RecurringSchedule }, now = new Date()): Promise<MonthlyEstimate> {
  return (await estimateMonthly([question], now))[0]
}

/** "About $3.20 a month (30 runs at about $0.11)" */
export function estimateLine(estimate: MonthlyEstimate): string {
  const runs = Math.round(estimate.runsPerMonth)
  return `About ${formatUsd(estimate.monthlyUsd)} a month (${runs} ${runs === 1 ? "run" : "runs"} at about ${formatUsd(estimate.perRunUsd)}${estimate.basis === "typical" ? ", a typical run" : estimate.basis === "own" ? ", from its last answers" : ", from recent recurring answers"})`
}
