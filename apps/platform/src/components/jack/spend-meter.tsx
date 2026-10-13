import { cn } from "@/lib/utils"
import { isOverBudget, spendBreakdown, spendLine, type JackSpend } from "@/lib/jack/spend"

/** "October: $3.20 of $200 · Lift $0.90", with the full split on hover */
export function SpendMeter({ spend, className }: { spend: JackSpend; className?: string }) {
  const over = isOverBudget(spend)
  return (
    <span
      title={`${spendBreakdown(spend)}${over ? ". The monthly budget is used up: replies are paused until next month." : ""}`}
      className={cn("text-xs tabular-nums", over ? "font-medium text-tone-danger-foreground" : "text-admin-subtle", className)}
    >
      {spendLine(spend)}
    </span>
  )
}
