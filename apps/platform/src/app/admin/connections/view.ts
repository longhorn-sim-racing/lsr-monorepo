import { formatDistance } from "date-fns"
import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import type { ConnectionRow } from "@/server/connectors/status"

/** A time, both ways: "5 minutes ago" and "Oct 22, 2026, 3:04 PM" (Central) */
export type When = { ago: string; at: string }

/** One row of the Connections page, ready to show. Names only: never an env value or a token */
export type ConnectionView = {
  id: string
  label: string
  /** "planned": a ConnectorState row whose connector isn't built yet */
  state: "connected" | "off" | "not_configured" | "error" | "planned"
  enabled: boolean
  env: { name: string; present: boolean }[]
  missingSettings: string[]
  hasSmoke: boolean
  lastSync: When | null
  /** Redacted. `current` when it's newer than the last sync */
  lastError: (When & { text: string; current: boolean }) | null
  lastSmoke: (When & { ok: boolean; summary: string; by: string | null }) | null
  details: { label: string; value: string }[]
}

export function when(date: Date | string | null | undefined, now = new Date()): When | null {
  if (!date) return null
  const at = new Date(date)
  if (Number.isNaN(at.getTime())) return null
  return { ago: formatDistance(at, now, { addSuffix: true }), at: formatInTimeZone(at, DEFAULT_TIMEZONE, "MMM d, yyyy, h:mm a") }
}

export function toConnectionView({ id, label, registered, requiredEnv, status, lastSmoke }: ConnectionRow, now = new Date()): ConnectionView {
  const errorAt = when(status.lastErrorAt, now)
  const current = Boolean(status.lastErrorAt && (!status.lastSyncAt || new Date(status.lastErrorAt) >= new Date(status.lastSyncAt)))
  const smokeAt = when(lastSmoke?.at, now)
  return {
    id,
    label,
    state: registered ? status.state : "planned",
    enabled: status.enabled,
    env: requiredEnv.map((name) => ({ name, present: !status.missingEnv.includes(name) })),
    missingSettings: status.missingSettings,
    hasSmoke: status.hasSmoke,
    lastSync: when(status.lastSyncAt, now),
    lastError: status.lastError && errorAt ? { ...errorAt, text: status.lastError, current } : null,
    lastSmoke: lastSmoke && smokeAt ? { ...smokeAt, ok: lastSmoke.ok, summary: lastSmoke.summary, by: lastSmoke.by } : null,
    details: status.details ?? [],
  }
}

/** The page's one-line summary: "1 connected · 2 off · 7 not built yet" */
export function connectionsSummary(rows: ConnectionView[]): string {
  if (!rows.length) return "Outside services Jack and the console use."
  const count = (state: ConnectionView["state"]) => rows.filter((row) => row.state === state).length
  const parts: [number, string][] = [
    [count("connected"), "connected"],
    [count("error"), "failing"],
    [count("off"), "off"],
    [count("not_configured"), "not set up"],
    [count("planned"), "not built yet"],
  ]
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ")
}
