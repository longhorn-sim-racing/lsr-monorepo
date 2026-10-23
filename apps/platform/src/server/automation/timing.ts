/**
 * How long an automation's scheduled note is looked after (design §11.1), in a module of its own so the
 * cap (cap.ts) can use it without loading the reply loop (answer.ts does).
 */

/** How long after finding the room busy the job looks again */
export const RETRY_AFTER_MS = 3 * 60_000
/** How long after its note was posted the job keeps looking again; until then the note is a run in flight (cap.ts) */
export const RETRY_WINDOW_MS = 45 * 60_000
