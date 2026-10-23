import { ACTIVE_STATUSES } from "@/lib/jack/publish"
import { INSTAGRAM_PUBLISH_ID, instagramPublishConnector } from "@/server/connectors/instagram/publish-connector"
import { refreshPublishToken } from "@/server/connectors/instagram/publish-token"
import { recordConnectorError, recordConnectorSync } from "@/server/connectors/state"
import { prisma } from "@/server/db"
import { plural } from "@/server/jack/proposals/changes/shared"
import type { JobContext, JobResult } from "@/server/scheduler/types"
import { finishInstagramPublishes, publishDeps } from "./instagram"

/**
 * The instagram-publish connector's two jobs (scheduler/jobs/decks-rooms.ts), both skipped while it's
 * switched off or not set up:
 * - finish: posts Instagram was still processing when they were approved, moved along until they're
 *   up or failed (each outcome is a room note);
 * - token: renews the publishing token weekly (it lasts 60 days, and can't be renewed once it's run out).
 */

const NOT_CONNECTED = "Instagram publishing isn't connected (switched off on Connections, Cloudinary's env missing, or no publishing token on Content → Instagram)"

export async function runInstagramPublishFinish({ signal, deadline, log }: Pick<JobContext, "signal" | "deadline" | "log">): Promise<JobResult> {
  const waiting = await prisma.instagramPublish.count({ where: { status: { in: ACTIVE_STATUSES } } })
  if (!waiting) return { summary: "No posts waiting on Instagram" }
  const client = await instagramPublishConnector.client()
  if (!client) return { summary: `${plural(waiting, "post")} waiting, but ${NOT_CONNECTED}`, status: "skipped" }
  const counts = await finishInstagramPublishes(publishDeps(client), { deadline, signal })
  if (counts.errors.length) {
    log(`Couldn't check ${plural(counts.errors.length, "post")} with Instagram; the next run tries again.`)
    await recordConnectorError(INSTAGRAM_PUBLISH_ID, new Error(counts.errors[0]))
  } else await recordConnectorSync(INSTAGRAM_PUBLISH_ID)
  const parts = [counts.published && `${plural(counts.published, "post")} went up`, counts.failed && `${plural(counts.failed, "post")} failed`, counts.waiting && `${plural(counts.waiting, "post")} still processing`, counts.busy && `${plural(counts.busy, "post")} being handled elsewhere`].filter(Boolean)
  return { summary: parts.join("; ") || "Nothing to move along", counts: { published: counts.published, failed: counts.failed, waiting: counts.waiting, busy: counts.busy, errors: counts.errors.length } }
}

export async function runInstagramPublishToken(): Promise<JobResult> {
  if (!(await instagramPublishConnector.client())) return { summary: NOT_CONNECTED, status: "skipped" }
  try {
    const outcome = await refreshPublishToken()
    if (outcome.status === "refreshed") await recordConnectorSync(INSTAGRAM_PUBLISH_ID)
    const summary =
      outcome.status === "refreshed"
        ? `Renewed the publishing token; it now runs out ${outcome.expiresAt.slice(0, 10)}`
        : outcome.status === "not-due"
          ? "The publishing token was renewed less than 6 days ago"
          : outcome.status === "replaced"
            ? "An admin saved a new token while this ran; kept theirs"
            : "No publishing token is saved"
    return { summary }
  } catch (error) {
    await recordConnectorError(INSTAGRAM_PUBLISH_ID, error)
    throw error
  }
}
