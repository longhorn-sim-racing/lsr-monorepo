import { runInstagramAccountSnapshot, runInstagramPostInsights, withInstagramInsights } from "@/server/connectors/instagram/sync"
import { runTwitchDailySnapshot, runTwitchLiveCheck, runTwitchTokenCheck, withTwitch } from "@/server/connectors/twitch/sync"
import type { JobKind } from "../types"

/**
 * Scheduled job kinds from the sources-b track (design §6, §12.2, §12.6): Twitch and Instagram insights.
 * Each is skipped while its connector is off or not set up. Like every job they ship switched off; turn
 * them on with their connector (docs/jack-2/tracks/sources-b.md).
 */
export const JOBS: JobKind[] = [
  {
    kind: "twitch.live",
    label: "Twitch live check",
    description:
      "Every minute: whether the club channel is live. While it is, saves the viewer count (peak and average come from these), keeps the stream's title, and opens the stream if its go-live webhook never came. Closes a stream after 3 checks in a row don't see it (the go-live and offline webhooks usually get there first).",
    defaultSchedule: "* * * * *",
    budgetMs: 45_000,
    run: ({ signal }) => withTwitch((client) => runTwitchLiveCheck({ client, signal })),
  },
  {
    kind: "twitch.daily",
    label: "Twitch daily snapshot",
    description:
      "Once a day: each past broadcast's VOD views (Twitch deletes VODs after a while, so the numbers are kept here), adding past broadcasts the site has no row for, and today's follower total.",
    defaultSchedule: "40 5 * * *",
    budgetMs: 90_000,
    run: ({ signal }) => withTwitch((client) => runTwitchDailySnapshot({ client, signal })),
  },
  {
    kind: "twitch.token-check",
    label: "Twitch token check",
    description:
      "Every hour: checks the club account's Twitch token with Twitch (Twitch requires it hourly), refreshing it when it's run out. If Twitch refuses it, an admin connects the club account again on Content → Streams. Also forgets webhook message ids older than 2 days.",
    defaultSchedule: "5 * * * *",
    budgetMs: 30_000,
    run: ({ signal }) => withTwitch((client) => runTwitchTokenCheck({ client, signal })),
  },
  {
    kind: "instagram.account-daily",
    label: "Instagram account snapshot",
    description:
      "Once a day: today's follower count, and the last 3 days' reach, views, accounts engaged, interactions, follows and unfollows (Instagram's numbers come in up to 2 days late and are gone after 90 days, so they're kept here).",
    defaultSchedule: "50 5 * * *",
    budgetMs: 60_000,
    run: ({ signal }) => withInstagramInsights((client) => runInstagramAccountSnapshot({ client, signal })),
  },
  {
    kind: "instagram.post-insights",
    label: "Instagram post insights",
    description:
      "Every hour: each recent post's reach, likes, comments, saves, shares and views. Hourly in a post's first week, daily up to 30 days, then monthly; posts not read yet go first, 30 a run.",
    defaultSchedule: "25 * * * *",
    budgetMs: 90_000,
    run: ({ signal, log }) => withInstagramInsights((client) => runInstagramPostInsights({ client, signal, log })),
  },
]
