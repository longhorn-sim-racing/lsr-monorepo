import { Stat } from "@/components/admin/kit"
import type { JackStatsDisplay } from "@/lib/jack/parts"

/** A few headline numbers as tiles (#188), like the stat strips on admin pages */
export function StatsView({ display }: { display: JackStatsDisplay }) {
  if (!display.items.length) return null
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
      {display.items.map((item, i) => (
        <Stat
          key={i}
          label={item.label}
          value={typeof item.value === "number" ? item.value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : item.value}
          hint={item.hint}
          className="px-3 py-2.5"
        />
      ))}
    </div>
  )
}
