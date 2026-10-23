import { formatInTimeZone } from "date-fns-tz"
import { prisma } from "@/server/db"
import { chicagoDay } from "@/lib/dates"
import type { JobResult } from "@/server/scheduler/types"
import { recordConnectorError, recordConnectorSync } from "../state"
import { INSTAGRAM_INSIGHTS_ID, instagramInsightsConnector, type InstagramInsightsClient } from "./connector"
import { InstagramGraphError } from "./graph"
import { MISSING_OBJECT_SUBCODE } from "./insights"

/**
 * What the Instagram insights jobs do (#188, design §12.6), registered in scheduler/jobs/sources-b.ts.
 * Instagram keeps account insights for 90 days and its numbers arrive up to 48 hours late, so:
 * - once a day, today's row in InstagramAccountDaily gets the follower count (Central date), and the
 *   rows of the last 3 days get that day's reach, views, accounts engaged, interactions, follows and
 *   unfollows again (a row is that day's follower snapshot, so days before the first run stay empty);
 * - every hour, recent posts get their reach, likes, comments, saves, shares and views on
 *   InstagramPost (the feed sync adds the posts): hourly in their first week, daily to 30 days, then
 *   once more a month; posts never read go first in line.
 */

type RunOptions = { client: InstagramInsightsClient; now?: Date; signal?: AbortSignal; log?: (line: string) => void }

const DAY = 86_400_000
const HOUR = 3_600_000
/** Days back whose numbers are read again, for Instagram's 48-hour lag */
export const ACCOUNT_DAYS_BACK = 3
/** Posts read per hourly run (one to seven calls each) */
export const POSTS_PER_RUN = 30

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const dayLabel = (date: Date) => formatInTimeZone(date, "UTC", "MMM d")

/** A plain explanation for the errors an officer has to act on; anything else as it came */
export function explainInstagramError(error: unknown): Error {
  if (!(error instanceof InstagramGraphError)) return error instanceof Error ? error : new Error(String(error))
  if (error.expiredToken) return new Error(`Instagram access has expired or was revoked: paste a new token in Admin → Instagram. (${error.message})`)
  if (error.missingPermission) return new Error(`The Instagram token doesn't have the insights permission (instagram_business_manage_insights): generate it again with that permission and paste it in Admin → Instagram. (${error.message})`)
  if (error.throttled) return new Error(`Instagram is rate limiting the app; the next run tries again. (${error.message})`)
  return error
}

/** Once a day: today's follower count, and the last 3 days' account totals */
export async function runInstagramAccountSnapshot(options: RunOptions): Promise<JobResult> {
  const result = await snapshotInstagramAccount(options)
  await recordConnectorSync(INSTAGRAM_INSIGHTS_ID)
  return result
}

/** The account snapshot's work, without recording a sync on the connector (the local DB check calls it alone) */
export async function snapshotInstagramAccount({ client, now = new Date(), signal }: RunOptions): Promise<JobResult> {
  const profile = await client.profile(signal)
  const igUserId = client.userId ?? profile.userId
  const today = chicagoDay(now)
  await prisma.instagramAccountDaily.upsert({ where: { date: today }, update: { followers: profile.followers }, create: { date: today, followers: profile.followers } })

  const days = Array.from({ length: ACCOUNT_DAYS_BACK }, (_, i) => new Date(today.getTime() - (i + 1) * DAY))
  const rows = new Set((await prisma.instagramAccountDaily.findMany({ where: { date: { in: days } }, select: { date: true } })).map((row) => row.date.getTime()))
  const filled: Date[] = []
  for (const day of days) {
    if (!rows.has(day.getTime())) continue
    signal?.throwIfAborted()
    const totals = await client.accountDay(igUserId, day, signal)
    await prisma.instagramAccountDaily.update({ where: { date: day }, data: totals })
    filled.push(day)
  }
  const range = filled.length ? `${dayLabel(filled[filled.length - 1])}–${dayLabel(filled[0])}` : "none yet: a day's numbers come in the day after its first snapshot"
  return { summary: `@${profile.username}: ${plural(profile.followers, "follower")}; account numbers for ${plural(filled.length, "day")} (${range})`, counts: { followers: profile.followers, days: filled.length } }
}

/** The posts whose numbers are due, newest first: hourly in their first week, daily to 30 days, monthly after, never-read ones first */
export async function postsDueForInsights(now: Date, limit = POSTS_PER_RUN): Promise<{ id: string }[]> {
  const due = (stale: number) => ({ OR: [{ insightsAt: null }, { insightsAt: { lt: new Date(now.getTime() - stale) } }] })
  const where = {
    OR: [
      { postedAt: { gte: new Date(now.getTime() - 7 * DAY) }, ...due(50 * 60_000) },
      { postedAt: { gte: new Date(now.getTime() - 30 * DAY), lt: new Date(now.getTime() - 7 * DAY) }, ...due(23 * HOUR) },
      { postedAt: { lt: new Date(now.getTime() - 30 * DAY) }, ...due(30 * DAY) },
    ],
  }
  const never = await prisma.instagramPost.findMany({ where: { AND: [where, { insightsAt: null }] }, orderBy: { postedAt: "desc" }, take: limit, select: { id: true } })
  if (never.length >= limit) return never
  const again = await prisma.instagramPost.findMany({ where: { AND: [where, { insightsAt: { not: null } }] }, orderBy: { postedAt: "desc" }, take: limit - never.length, select: { id: true } })
  return [...never, ...again]
}

/** Every hour: the numbers of the posts that are due. A post Instagram has no numbers for (deleted, or too few viewers) is marked read and skipped; a dead token or a missing permission stops the run */
export async function runInstagramPostInsights(options: RunOptions): Promise<JobResult> {
  const result = await readPostInsights(await postsDueForInsights(options.now ?? new Date()), options)
  await recordConnectorSync(INSTAGRAM_INSIGHTS_ID)
  return result
}

/** Reads and stores the numbers of these posts, without recording a sync on the connector (the local DB check calls it on its own post) */
export async function readPostInsights(posts: { id: string }[], { client, now = new Date(), signal, log }: RunOptions): Promise<JobResult> {
  let updated = 0
  let missing = 0
  for (const post of posts) {
    if (signal?.aborted) {
      log?.("Stopped at the time limit; the next run continues.")
      break
    }
    try {
      const numbers = await client.post(post.id, signal)
      await prisma.instagramPost.updateMany({ where: { id: post.id }, data: { ...numbers, insightsAt: now } })
      updated++
    } catch (error) {
      const gone = error instanceof InstagramGraphError && ((error.code === 100 && error.subcode === MISSING_OBJECT_SUBCODE) || error.tooFewViewers)
      if (!gone) throw error
      // Deleted on Instagram (the feed sync removes it soon), not readable, or too few viewers to show: don't ask again every hour
      await prisma.instagramPost.updateMany({ where: { id: post.id }, data: { insightsAt: now } })
      missing++
    }
  }
  return {
    summary: posts.length ? `Read the numbers of ${plural(updated, "post")}${missing ? `; Instagram had no numbers for ${plural(missing, "post")} (deleted, or too few viewers)` : ""}` : "No posts due",
    counts: { updated, missing },
  }
}

/** Runs one of the above with the connector's client: "skipped" when there's none. A failure is recorded on the connector (explained, redacted) and thrown */
export async function withInstagramInsights(run: (client: InstagramInsightsClient) => Promise<JobResult>): Promise<JobResult> {
  const client = await instagramInsightsConnector.client()
  if (!client) return { summary: "Instagram insights aren't connected (switched off on Connections, or no token in Admin → Instagram)", status: "skipped" }
  try {
    return await run(client)
  } catch (error) {
    const explained = explainInstagramError(error)
    await recordConnectorError(INSTAGRAM_INSIGHTS_ID, explained)
    throw explained
  }
}
