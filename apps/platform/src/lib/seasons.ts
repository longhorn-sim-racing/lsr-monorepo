/** "Lone Star Cup | Season 3" → "Season 3" */
export const seasonLabel = (name: string) => name.split("|").pop()!.trim()

/** "Spring 2026" / "Fall 2025" from a season's start date */
export function seasonTerm(startAt: Date | null) {
  if (!startAt) return null
  return `${startAt.getUTCMonth() < 6 ? "Spring" : "Fall"} ${startAt.getUTCFullYear()}`
}
