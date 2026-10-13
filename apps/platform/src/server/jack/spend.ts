import { fromZonedTime } from "date-fns-tz"
import type { JackSpend } from "@/lib/jack/spend"
import type { JackPersonaKey } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { roundUsd } from "./cost"

const TZ = "America/Chicago"

/** What Jack may spend in a calendar month before he stops calling Claude: JACK_MONTHLY_BUDGET_USD, default $200 */
export const DEFAULT_MONTHLY_BUDGET_USD = 200

export function jackMonthlyBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.JACK_MONTHLY_BUDGET_USD?.trim()
  const value = raw ? Number(raw) : Number.NaN
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MONTHLY_BUDGET_USD
}

/** The calendar month `now` falls in, in Central Time: [start, end) as instants, and its name */
export function chicagoMonth(now: Date): { start: Date; end: Date; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric" }).formatToParts(now)
  const year = Number(parts.find((p) => p.type === "year")?.value)
  const month = Number(parts.find((p) => p.type === "month")?.value) // 1-12
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
  const iso = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01T00:00:00`
  return {
    start: fromZonedTime(iso(year, month), TZ),
    end: fromZonedTime(iso(next.year, next.month), TZ),
    label: new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "long" }).format(now),
  }
}

type CostRow = { kind: "user" | "assistant" | "system"; persona: JackPersonaKey | null; costUsd: number }

/** Replies count for their persona; system rows with a cost are Stand's side jobs */
export function summarizeSpend(rows: CostRow[], month: string, budgetUsd: number): JackSpend {
  const byPersona: Record<JackPersonaKey, number> = { jack: 0, lift: 0, stand: 0 }
  for (const row of rows) {
    const persona: JackPersonaKey = row.kind === "assistant" && row.persona ? row.persona : "stand"
    byPersona[persona] += row.costUsd
  }
  for (const key of Object.keys(byPersona) as JackPersonaKey[]) byPersona[key] = roundUsd(byPersona[key])
  return { month, budgetUsd, byPersona, totalUsd: roundUsd(byPersona.jack + byPersona.lift + byPersona.stand) }
}

/** This month's spend, from the cost saved on each reply and side job */
export async function getMonthSpend(now = new Date()): Promise<JackSpend> {
  const { start, end, label } = chicagoMonth(now)
  const groups = await prisma.jackMessage.groupBy({
    by: ["kind", "persona"],
    where: { createdAt: { gte: start, lt: end }, costUsd: { not: null } },
    _sum: { costUsd: true },
  })
  const rows = groups.map((group) => ({ kind: group.kind, persona: group.persona, costUsd: Number(group._sum.costUsd ?? 0) }))
  return summarizeSpend(rows, label, jackMonthlyBudgetUsd())
}
