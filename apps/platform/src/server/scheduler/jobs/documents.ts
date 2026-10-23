import { runDriveSyncJob } from "@/server/connectors/google-drive/job"
import { runSharePointSyncJob } from "@/server/connectors/sharepoint/job"
import { runTeamsSubscriptionsJob, runTeamsSyncJob } from "@/server/connectors/teams/job"
import type { JobKind } from "../types"

/** Scheduled job kinds from the documents track (design §6, §12.7, §12.8). The registry joins every track's jobs in a fixed order */
export const JOBS: JobKind[] = [
  {
    kind: "google-drive.sync",
    label: "Google Drive sync",
    description:
      "Keeps Jack's copy of the club's shared Drive folder current: what changed since the last run, and a full walk the first time and every week (files that left the folder are removed). Reads Docs, Sheets (first tab), Slides, PDFs, Word and PowerPoint files and transcripts. Skipped while Google Drive isn't connected.",
    defaultSchedule: "*/15 * * * *",
    budgetMs: 280_000,
    handoff: true,
    run: (ctx) => runDriveSyncJob(ctx),
  },
  {
    kind: "sharepoint.sync",
    label: "SharePoint sync",
    description:
      "Keeps Jack's copy of the club team's SharePoint library current through Graph's delta, with a full enumeration the first time and every week (files no longer there are removed). Skipped while SharePoint isn't connected.",
    defaultSchedule: "5 * * * *",
    budgetMs: 280_000,
    handoff: true,
    run: (ctx) => runSharePointSyncJob(ctx),
  },
  {
    kind: "teams.subscriptions",
    label: "Teams change notifications",
    description:
      "Keeps a Graph subscription on each configured Teams channel, so new, edited and deleted messages reach Jack's copy within moments: creates missing ones, renews ones expiring within 36 hours (they last 3 days), and removes ones for channels no longer configured. Skipped while Teams isn't connected.",
    defaultSchedule: "20 */12 * * *",
    budgetMs: 60_000,
    run: (ctx) => runTeamsSubscriptionsJob(ctx),
  },
  {
    kind: "teams.sync",
    label: "Teams daily reconcile",
    description:
      "Once a day (Microsoft allows polling a channel once a day), reads each configured Teams channel's changes to catch anything a notification missed; the first run copies each channel's messages. Deleted messages lose their text. Skipped while Teams isn't connected.",
    defaultSchedule: "40 5 * * *",
    budgetMs: 280_000,
    handoff: true,
    run: (ctx) => runTeamsSyncJob(ctx),
  },
]
