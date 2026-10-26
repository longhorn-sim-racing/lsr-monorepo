import { runInstagramPublishFinish, runInstagramPublishToken } from "@/server/jack/publish/jobs"
import type { JobKind } from "../types"

/**
 * Scheduled job kinds from the decks-rooms track (design §6): Instagram publishing. The registry joins
 * every track's jobs in a fixed order. Both are skipped while the instagram-publish connector is off or
 * not set up, and ship switched off like every job; turn them on with the connector
 * (docs/jack-2/tracks/decks-rooms.md).
 */
export const JOBS: JobKind[] = [
  {
    kind: "instagram-publish.finish",
    label: "Instagram posts follow-up",
    description:
      "Every 5 minutes: posts officers approved that Instagram was still processing are checked and posted once Instagram has finished (never twice: a post whose last call got no answer is looked for first). Each outcome goes to its room as a note. Does nothing while no post is waiting.",
    defaultSchedule: "*/5 * * * *",
    budgetMs: 90_000,
    run: ({ signal, deadline, log }) => runInstagramPublishFinish({ signal, deadline, log }),
  },
  {
    kind: "instagram-publish.token",
    label: "Instagram publishing token renewal",
    description:
      "Once a week: renews the publishing token (Instagram's last 60 days and can't be renewed once they run out). If Instagram refuses, an admin pastes a new token on Content → Instagram.",
    defaultSchedule: "15 5 * * 1",
    budgetMs: 30_000,
    run: () => runInstagramPublishToken(),
  },
]
