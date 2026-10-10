/**
 * The parts of a league round's event title, e.g.
 * "Lone Star Cup S3 Round 7 @ Mount Panorama (Halloween Night Race)" or "Lone Star Cup S2 FINAL Round @ Nürburgring".
 * `index` is the round's position in the season, used when the title has no round number.
 */
export function parseRoundTitle(title: string, index: number) {
  const final = /\bfinal\b/i.test(title)
  const number = title.match(/\bRound\s+(\d+(?:\.\d+)?)/i)?.[1] ?? (final ? null : String(index + 1))
  const place = title.includes("@")
    ? title.split("@").pop()!.trim()
    : title.replace(/^.*?\bRound\s+[\d.]+\s*[:\-–]?\s*/i, "").trim() || title
  const note = place.match(/\(([^)]+)\)\s*$/)?.[1] ?? null
  return {
    /** "R7", "R3.5", or "F" for the final */
    short: final ? "F" : `R${number}`,
    /** "Round 7" or "Final round" */
    name: final ? "Final round" : `Round ${number}`,
    number,
    track: place.replace(/\s*\([^)]*\)\s*$/, ""),
    note,
    night: !!note && /night/i.test(note),
    final,
  }
}
