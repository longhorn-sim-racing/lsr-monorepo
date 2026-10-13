import type { Tone } from "@/components/admin/kit"

export type SeasonPhase = "upcoming" | "running" | "ended" | "undated"

/** Where a season is relative to now, from its Central-time start and end dates. */
export function seasonPhase(season: { startAt: Date | null; endAt: Date | null }, now = new Date()): SeasonPhase {
  const { startAt, endAt } = season
  if (!startAt && !endAt) return "undated"
  if (startAt && now < startAt) return "upcoming"
  if (endAt && now > endAt) return "ended"
  return "running"
}

export const PHASE_LABEL: Record<SeasonPhase, string> = { upcoming: "Upcoming", running: "Running", ended: "Ended", undated: "No dates" }
export const PHASE_TONE: Record<SeasonPhase, Tone> = { upcoming: "info", running: "success", ended: "neutral", undated: "neutral" }
