/**
 * Jack's timing that the server and the room page share (#161). Plain values only; this is imported
 * by client components.
 *
 * ROOM_LOCK_STALE_MS: a room's run lock older than this is from a run that died, and the next one (a
 * post, or an officer asking Jack to continue) takes it over (src/server/jack/room-lock.ts). It has to
 * be longer than a run can live: the room page's function stops at maxDuration (300 s), a run cancels
 * whatever it's doing 280 s in (RUN_TIMING in src/server/jack/reply-loop.ts), and it renews the lock
 * before each answer, so a live run's lock is never older than about 300 s. Six minutes leaves a
 * margin and keeps a dead run's room stuck no longer than that. The room page offers "continue" for a
 * reply that's been quiet longer than this (room-state.ts).
 */
export const ROOM_LOCK_STALE_MS = 6 * 60 * 1000
