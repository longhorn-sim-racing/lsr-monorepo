"use client"

import type { JackToolPart } from "@/lib/jack/parts"

/**
 * One tool call inside a reply: its label, then what it shows (SQL, a table, a chart, an event draft).
 * Placeholder until the tools step draws the displays.
 */
export function JackToolPartView({ part }: { part: JackToolPart }) {
  return (
    <div className="max-w-2xl rounded-md border bg-admin-surface px-2.5 py-1.5 text-xs text-muted-foreground">
      {part.status === "running" ? `${part.label}…` : part.label}
    </div>
  )
}
