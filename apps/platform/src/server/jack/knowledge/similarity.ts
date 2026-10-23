/**
 * When a new knowledge entry is too close to an existing one (design §9: a save first checks for
 * similar entries and refuses unless the call names them). Postgres's english parser turns both into
 * lexemes (stemmed words without stop words: "meetings" and "meeting" are one); this decides from the
 * sizes of those sets and how much they share. Pure, so the thresholds are tested without a database.
 */

/** Set sizes for one existing entry against the new one, as the duplicate query counts them */
export type LexemeCounts = {
  /** Distinct lexemes in the new entry's title, and in its whole text (title, tags and body) */
  newTitle: number
  newText: number
  /** The same for the existing entry */
  oldTitle: number
  oldText: number
  /** How many of them the two share */
  sharedTitle: number
  sharedText: number
}

/**
 * - Titles: Jaccard (shared / either) of 0.6 or more, e.g. "Dues policy" and "Dues policy for fall".
 * - Text: one entry mostly inside the other (shared / the smaller one, at least 0.7 with at least 5
 *   lexemes shared), or the two mostly the same (Jaccard 0.45 or more, at least 3 shared).
 * False positives cost one extra call (the save names the entry in notDuplicateOf); misses leave a
 * duplicate for an officer to merge, so these lean towards asking.
 */
export const DUPLICATE_THRESHOLDS = {
  title: 0.6,
  containment: 0.7,
  containmentMinShared: 5,
  text: 0.45,
  textMinShared: 3,
} as const

export type DuplicateMatch = { score: number; reason: "title" | "text" }

const jaccard = (shared: number, a: number, b: number) => (a + b - shared > 0 ? shared / (a + b - shared) : 0)

/** Whether an existing entry looks like a duplicate of the new one, and how close (0 to 1), or null */
export function duplicateMatch(counts: LexemeCounts, thresholds = DUPLICATE_THRESHOLDS): DuplicateMatch | null {
  const title = counts.sharedTitle > 0 ? jaccard(counts.sharedTitle, counts.newTitle, counts.oldTitle) : 0
  const smaller = Math.min(counts.newText, counts.oldText)
  const containment = smaller > 0 && counts.sharedText >= thresholds.containmentMinShared ? counts.sharedText / smaller : 0
  const text = counts.sharedText >= thresholds.textMinShared ? jaccard(counts.sharedText, counts.newText, counts.oldText) : 0

  const titleHit = title >= thresholds.title ? title : 0
  const textHit = Math.max(containment >= thresholds.containment ? containment : 0, text >= thresholds.text ? text : 0)
  if (!titleHit && !textHit) return null
  return titleHit >= textHit ? { score: round(titleHit), reason: "title" } : { score: round(textHit), reason: "text" }
}

const round = (n: number) => Math.round(n * 100) / 100
