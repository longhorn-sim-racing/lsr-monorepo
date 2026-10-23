import { prisma } from "@/server/db"
import { chicagoDay } from "@/lib/dates"
import { readConnectorState, recordConnectorError, recordConnectorSync } from "../state"
import type { JobResult } from "@/server/scheduler/types"
import { TWITCH_CONNECTOR_ID, twitchConnector, type TwitchClient } from "./connector"
import { closeStreams, EMPTY_CHECKS_TO_CLOSE, recordStreamOnline, recordVideos, recordViewerSample, updateStreamDetails } from "./streams"

/**
 * What the Twitch jobs do (#188, design §12.2), registered in scheduler/jobs/sources-b.ts. Each one
 * returns "skipped" while the connector is switched off or not set up, records its sync or error on the
 * connector, and is safe to run twice.
 */

type RunOptions = { client: TwitchClient; now?: Date; signal?: AbortSignal; log?: (line: string) => void }

/** The live check's memory between runs: misses in a row while a stream is open. No credentials */
export type TwitchLiveCursor = { misses?: number; missedSince?: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Every minute: whether the channel is live. Live: makes sure the stream has a row (a missed
 * stream.online), keeps its title, and samples the viewers. Not live while a stream is open: closes it
 * after EMPTY_CHECKS_TO_CLOSE misses in a row, at the time of the last sample (Get Streams lags and can
 * flap, so one miss proves nothing; stream.offline usually closes it first)
 */
export async function runTwitchLiveCheck({ client, now = new Date(), signal }: RunOptions): Promise<JobResult> {
  const live = await client.liveStream(signal)
  const cursor = ((await readConnectorState(TWITCH_CONNECTOR_ID))?.cursor ?? {}) as TwitchLiveCursor

  if (live) {
    const existing = await prisma.twitchStream.findUnique({ where: { id: live.id }, select: { endedAt: true } })
    if (existing?.endedAt) {
      await recordConnectorSync(TWITCH_CONNECTOR_ID, { cursor: {} })
      return { summary: `Live, but stream ${live.id} was already closed by stream.offline; Get Streams is behind`, counts: { viewers: live.viewers } }
    }
    const { created } = existing ? { created: false } : await recordStreamOnline({ id: live.id, startedAt: live.startedAt, title: live.title, gameName: live.gameName })
    if (!created) await updateStreamDetails(live.id, { title: live.title, gameName: live.gameName })
    await recordViewerSample(live.id, now, live.viewers)
    await recordConnectorSync(TWITCH_CONNECTOR_ID, { cursor: {} })
    return { summary: `Live: ${plural(live.viewers, "viewer")}${created ? " (opened the stream: its stream.online never came)" : ""}`, counts: { viewers: live.viewers } }
  }

  const open = await prisma.twitchStream.findMany({ where: { endedAt: null }, select: { id: true } })
  if (!open.length) {
    await recordConnectorSync(TWITCH_CONNECTOR_ID, { cursor: {} })
    return { summary: "Offline" }
  }
  const misses = (cursor.misses ?? 0) + 1
  const missedSince = cursor.missedSince ?? now.toISOString()
  if (misses < EMPTY_CHECKS_TO_CLOSE) {
    await recordConnectorSync(TWITCH_CONNECTOR_ID, { cursor: { misses, missedSince } satisfies TwitchLiveCursor })
    return { summary: `Get Streams didn't list the open stream (${misses} of ${EMPTY_CHECKS_TO_CLOSE} misses before closing it)` }
  }
  // It ended between its last sample and the first miss
  const lastSample = await prisma.twitchViewerSample.findFirst({ where: { streamId: { in: open.map((s) => s.id) } }, orderBy: { at: "desc" }, select: { at: true } })
  const closed = await closeStreams({ endedAt: lastSample?.at ?? new Date(missedSince), startedBefore: now })
  await recordConnectorSync(TWITCH_CONNECTOR_ID, { cursor: {} })
  return { summary: `Closed ${plural(closed, "stream")}: not live for ${EMPTY_CHECKS_TO_CLOSE} checks in a row (stream.offline never came)`, counts: { closed } }
}

/** Once a day: each past broadcast's VOD views (adding broadcasts without a row), and the follower total for today (Central) */
export async function runTwitchDailySnapshot({ client, now = new Date(), signal }: RunOptions): Promise<JobResult> {
  const videos = await client.archiveVideos({ max: 300, signal })
  const { updated, added } = await recordVideos(videos, now)
  const followers = await client.followerTotal(signal)
  const date = chicagoDay(now)
  await prisma.twitchChannelDaily.upsert({ where: { date }, update: { followers }, create: { date, followers } })
  await recordConnectorSync(TWITCH_CONNECTOR_ID)
  return {
    summary: `${plural(videos.length, "past broadcast")} on Twitch (${updated} updated, ${added} added); ${plural(followers, "follower")}`,
    counts: { videos: videos.length, updated, added, followers },
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
