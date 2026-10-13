import { JACK_PERSONA_NAME, type JackPersonaKey } from "./types"

/** What Jack has cost this calendar month (Central Time), as the pages show it. Plain JSON */
export type JackSpend = {
  /** "October" */
  month: string
  totalUsd: number
  budgetUsd: number
  byPersona: Record<JackPersonaKey, number>
}

export function formatUsd(amount: number, { wholeIfRound = false } = {}): string {
  if (amount > 0 && amount < 0.005) return "<$0.01"
  if (wholeIfRound && Number.isInteger(amount)) return `$${amount.toLocaleString("en-US")}`
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** "October: $3.20 of $200 · Lift $0.90" (Lift only when it has cost something) */
export function spendLine(spend: JackSpend): string {
  const total = `${spend.month}: ${formatUsd(spend.totalUsd)} of ${formatUsd(spend.budgetUsd, { wholeIfRound: true })}`
  return spend.byPersona.lift > 0 ? `${total} · Lift ${formatUsd(spend.byPersona.lift)}` : total
}

/** "Jack $2.25 · Lift $0.90 · Stand $0.05", for a tooltip */
export function spendBreakdown(spend: JackSpend): string {
  return (["jack", "lift", "stand"] as const).map((persona) => `${JACK_PERSONA_NAME[persona]} ${formatUsd(spend.byPersona[persona])}`).join(" · ")
}

export function isOverBudget(spend: Pick<JackSpend, "totalUsd" | "budgetUsd">): boolean {
  return spend.totalUsd >= spend.budgetUsd
}
