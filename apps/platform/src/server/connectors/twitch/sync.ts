import type { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import { chicagoDay } from "@/lib/dates"
import { readConnectorState, recordConnectorError, recordConnectorSync } from "../state"
import type { JobResult } from "@/server/scheduler/types"
import { TWITCH_CONNECTOR_ID, twitchConnector, type TwitchClient } from "./connector"
import { closeStreams, EMPTY_CHECKS_TO_CLOSE, recordStreamOnline, recordVideos, recordViewerSample, reopenStream, START_LAG_MS, updateStreamDetails } from "./streams"

/**
 * What the Twitch jobs do (#188, design §12.2), registered in scheduler/jobs/sources-b.ts. Each one
 * returns "skipped" while the connector is switched off or not set up, records its sync or error on the
 * connector, and is safe to run twice. A run that wrote nothing (the live check while offline) doesn't
 * count as a sync, so an error from another job still shows until a run that did something succeeds.
 */

type RunOptions = { client: TwitchClient; now?: Date; signal?: AbortSignal; log?: (line: string) => void }

/**
 * The live check's memory between runs (no credentials): misses in a row while a stream is open, and
 * the streams it closed itself, newest first (only stream.offline is final: these are reopened if Get
 * Streams lists them again)
 */
export type TwitchLiveCursor = { misses?: number; missedSince?: string; closedByCheck?: string[] }

/** How many of the streams the live check closed it remembers */
const REMEMBER_CLOSED = 5

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Keeps the live check's cursor without stamping lastSyncAt: for runs that wrote nothing */
async function saveLiveCursor(cursor: TwitchLiveCursor): Promise<void> {
  const value = cursor as Prisma.InputJsonValue
  await prisma.connectorState.upsert({ where: { id: TWITCH_CONNECTOR_ID }, update: { cursor: value }, create: { id: TWITCH_CONNECTOR_ID, enabled: false, cursor: value } })
}

/**
 * Every minute: whether the channel is live. Live: makes sure the stream has a row (a missed
 * stream.online, or one this check closed too early), keeps its title, and samples the viewers. Not
 * live while a stream is open: closes it after EMPTY_CHECKS_TO_CLOSE misses in a row, at the time of the
 * last sample (Get Streams lags and can flap, so one miss proves nothing; stream.offline usually closes
 * it first). A stream that went live less than START_LAG_MS ago and has no samples yet isn't missed:
 * Get Streams can take minutes to list a new stream.
 */
export async function runTwitchLiveCheck({ client, now = new Date(), signal }: RunOptions): Promise<JobResult> {
  const live = await client.liveStream(signal)
  const cursor = ((await readConnectorState(TWITCH_CONNECTOR_ID))?.cursor ?? {}) as TwitchLiveCursor
  const closedByCheck = Array.isArray(cursor.closedByCheck) ? cursor.closedByCheck : []

  if (live) {
    const existing = await prisma.twitchStream.findUnique({ where: { id: live.id }, select: { endedAt: true } })
    let reopened = false
    if (existing?.endedAt) {
      if (!closedByCheck.includes(live.id)) {
        await saveLiveCursor({ closedByCheck })
        return { summary: `Live, but stream ${live.id} was already closed by stream.offline; Get Streams is behind`, counts: { viewers: live.viewers } }
      }
      reopened = await reopenStream(live.id)
    }
    const { created } = existing ? { created: false } : await recordStreamOnline({ id: live.id, startedAt: live.startedAt, title: live.title, gameName: live.gameName })
    if (!created) await updateStreamDetails(live.id, { title: live.title, gameName: live.gameName })
    await recordViewerSample(live.id, now, live.viewers)
    await recordConnectorSync(TWITCH_CONNECTOR_ID, { cursor: { closedByCheck: closedByCheck.filter((id) => id !== live.id) } satisfies TwitchLiveCursor })
    const note = created ? " (opened the stream: its stream.online never came)" : reopened ? " (reopened the stream: Get Streams had stopped listing it for a while)" : ""
    return { summary: `Live: ${plural(live.viewers, "viewer")}${note}`, counts: { viewers: live.viewers } }
  }

  const open = await prisma.twitchStream.findMany({ where: { endedAt: null }, select: { id: true, startedAt: true, avgViewers: true } })
  if (!open.length) {
    await saveLiveCursor({ closedByCheck })
    return { summary: "Offline" }
  }
  // Get Streams can leave a new stream out for minutes: only a stream it has listed (sampled) or an older one can be missed
  const missing = open.filter((s) => s.avgViewers !== null || now.getTime() - s.startedAt.getTime() >= START_LAG_MS)
  if (!missing.length) {
    await saveLiveCursor({ closedByCheck })
    return { summary: `Get Streams doesn't list the stream that just went live yet (it lags); not counted as a miss for its first ${START_LAG_MS / 60_000} minutes` }
  }
  const misses = (cursor.misses ?? 0) + 1
  const missedSince = cursor.missedSince ?? now.toISOString()
  if (misses < EMPTY_CHECKS_TO_CLOSE) {
    await saveLiveCursor({ misses, missedSince, closedByCheck })
    return { summary: `Get Streams didn't list the open stream (${misses} of ${EMPTY_CHECKS_TO_CLOSE} misses before closing it)` }
  }
  // It ended between its last sample and the first miss
  const ids = missing.map((s) => s.id)
  const lastSample = await prisma.twitchViewerSample.findFirst({ where: { streamId: { in: ids } }, orderBy: { at: "desc" }, select: { at: true } })
  const closed = await closeStreams({ endedAt: lastSample?.at ?? new Date(missedSince), ids })
  await recordConnectorSync(TWITCH_CONNECTOR_ID, { cursor: { closedByCheck: [...ids, ...closedByCheck.filter((id) => !ids.includes(id))].slice(0, REMEMBER_CLOSED) } satisfies TwitchLiveCursor })
  return { summary: `Closed ${plural(closed, "stream")}: not live for ${EMPTY_CHECKS_TO_CLOSE} checks in a row (stream.offline never came)`, counts: { closed } }
}

/** Once a day: each past broadcast's VOD views (adding broadcasts without a row, unless one may still be live), and the follower total for today (Central) */
export async function runTwitchDailySnapshot({ client, now = new Date(), signal }: RunOptions): Promise<JobResult> {
  const videos = await client.archiveVideos({ max: 300, signal })
  const live = await client.liveStream(signal)
  const { updated, added, deferred } = await recordVideos(videos, now, { liveStreamId: live?.id })
  const followers = await client.followerTotal(signal)
  const date = chicagoDay(now)
  await prisma.twitchChannelDaily.upsert({ where: { date }, update: { followers }, create: { date, followers } })
  await recordConnectorSync(TWITCH_CONNECTOR_ID)
  return {
    summary: `${plural(videos.length, "past broadcast")} on Twitch (${updated} updated, ${added} added${deferred ? `, ${deferred} left for the live check: may still be live` : ""}); ${plural(followers, "follower")}`,
    counts: { videos: videos.length, updated, added, ...(deferred ? { deferred } : {}), followers },
  }
}

/** Every hour: Twitch's required validation of the club account's token (and the app token), then prunes old EventSub message ids */
export async function runTwitchTokenCheck({ client, now = new Date(), signal }: RunOptions): Promise<JobResult> {
  await client.checkAppToken(signal)
  const account = await client.checkClubAccount(signal)
  const { count } = await prisma.twitchEventSubMessage.deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - 2 * 86_400_000) } } })
  await recordConnectorSync(TWITCH_CONNECTOR_ID)
  return { summary: `The club account @${account.login} is valid (its token has ${Math.max(0, Math.round(account.expiresIn / 60))} minutes left)`, counts: { prunedMessages: count } }
}

/**
 * Runs one of the above with the connector's client: "skipped" when there's none (switched off, or env or
 * the club account missing). A failure is recorded on the connector (redacted) and thrown for the run log
 */
export async function withTwitch(run: (client: TwitchClient) => Promise<JobResult>): Promise<JobResult> {
  const client = await twitchConnector.client()
  if (!client) return { summary: "Twitch isn't connected (switched off on Connections, or its env vars or the club account are missing)", status: "skipped" }
  try {
    return await run(client)
  } catch (error) {
    await recordConnectorError(TWITCH_CONNECTOR_ID, error)
    throw error
  }
}
