"use client"

import { Button } from "@/components/admin/kit"
import { cn } from "@/lib/utils"

/**
 * An on/off button for a list that refreshes itself while it's on. A candidate for the kit: any live list
 * (audit log, check-ins) can use it.
 */
export function LiveTailToggle({
  on,
  onChange,
  intervalLabel = "every 3 seconds",
}: {
  on: boolean
  onChange: (on: boolean) => void
  /** For the tooltip: how often it refreshes */
  intervalLabel?: string
}) {
  return (
    <Button
      aria-pressed={on}
      onClick={() => onChange(!on)}
      title={on ? "Stop checking for new entries" : `Check for new entries ${intervalLabel}`}
      className={cn(on && "border-tone-success-foreground/40 bg-tone-success text-tone-success-foreground hover:bg-tone-success")}
    >
      <span className="relative flex size-2" aria-hidden>
        {on && <span className="absolute inline-flex size-full animate-ping rounded-full bg-tone-success-foreground opacity-60" />}
        <span className={cn("relative inline-flex size-2 rounded-full", on ? "bg-tone-success-foreground" : "bg-admin-subtle")} />
      </span>
      {on ? "Live" : "Live tail"}
    </Button>
  )
}
