/**
 * Officers' thumbs up or down on Jack's replies (#188, design §10). One rating per officer per reply,
 * changeable, with an optional short note. A thumbs-down with a note is an eval candidate on the Usage
 * page. Plain JSON: the room page gets these.
 */

export type JackFeedbackRating = "up" | "down"

/** The most a note may hold */
export const FEEDBACK_NOTE_MAX = 500

export function isFeedbackRating(value: unknown): value is JackFeedbackRating {
  return value === "up" || value === "down"
}

/** One officer's rating of a reply */
export type JackFeedbackRater = { userId: string; name: string; rating: JackFeedbackRating; note: string | null }

/** A reply's ratings, as one officer sees them */
export type JackFeedbackSummary = {
  up: number
  down: number
  /** The viewing officer's own rating, if they gave one */
  mine: { rating: JackFeedbackRating; note: string | null } | null
  /** Everyone's, oldest first: shown on hover */
  raters: JackFeedbackRater[]
}

/** A feedback row as the database has it, with the rater's name */
export type FeedbackRow = { messageId: string; userId: string; rating: string; note: string | null; user: { displayName: string } | null }

/** Each reply's ratings, by message id, as `viewerId` sees them. Rows with a rating that isn't up or down are skipped */
export function summarizeFeedback(rows: FeedbackRow[], viewerId: string): Record<string, JackFeedbackSummary> {
  const out: Record<string, JackFeedbackSummary> = {}
  for (const row of rows) {
    if (!isFeedbackRating(row.rating)) continue
    const summary = (out[row.messageId] ??= { up: 0, down: 0, mine: null, raters: [] })
    summary[row.rating]++
    summary.raters.push({ userId: row.userId, name: row.user?.displayName ?? "An officer", rating: row.rating, note: row.note })
    if (row.userId === viewerId) summary.mine = { rating: row.rating, note: row.note }
  }
  return out
}

/** "Gray: thumbs down, “wrong date” · Alex: thumbs up", for a tooltip */
export function feedbackTooltip(summary: JackFeedbackSummary): string {
  return summary.raters.map((r) => `${r.name}: thumbs ${r.rating}${r.note ? `, “${r.note}”` : ""}`).join(" · ")
}
