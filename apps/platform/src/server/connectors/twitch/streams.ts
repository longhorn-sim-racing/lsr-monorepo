import { prisma } from "@/server/db"
import type { TwitchVideo } from "./connector"

/**
 * The life of a TwitchStream row (#188, design §12.2). Other tracks read it through the helpers at the
 * bottom (the Discord `twitch_live` rule: currentLiveStream, streamsWentLiveSince).
 *
 * - **Opens** when EventSub's stream.online (type "live" only) arrives, or when the live check sees a
 *   stream it has no row for (a missed webhook). id = Twitch's stream id, the same as Get Streams' id and
 *   the VOD's stream_id. The webhook can't wait for Helix, so `title` may be "" for a few seconds until
 *   Get Channel Information (or the next live check) fills it in.
 * - **Samples** once a minute while open (the live check): TwitchViewerSample rows, peakViewers and a
 *   running avgViewers. viewer_count is concurrent viewers, cached by Twitch, not unique viewers.
 *   avgViewers is set from the first sample on, so `avgViewers !== null` means the viewers were counted,
 *   also after the samples are pruned (180 days).
 * - **Closes** (endedAt) on stream.offline, or after 3 live checks in a row that don't see it (one empty
 *   Get Streams result isn't trusted, and a stream that just went live isn't counted as missing for its
 *   first START_LAG_MS: Get Streams can take minutes to list it). Only stream.offline is final: a stream
 *   the live check closed is reopened when Get Streams lists it again. A reconnect after an encoder drop
 *   is a new stream with a new id, and the old one is closed when the new one opens.
 * - **Live now** means open and seen lately: its last sample (or its start, before the first) is less
 *   than LIVE_STALE_MS old. An open row nothing has touched for longer (the connector or its jobs were
 *   switched off mid-stream) isn't live; the live check closes it once it runs again.
 * - **VOD**: the daily snapshot sets vodId and vodViews, and adds rows for past broadcasts it finds
 *   without one (peakViewers 0 and avgViewers null there: viewers weren't sampled), but not for one
 *   that may still be live.
 */

/** Live checks in a row that must miss an open stream before it's closed */
export const EMPTY_CHECKS_TO_CLOSE = 3

/** How long after going live a stream without samples isn't counted as missing (Get Streams lags) */
export const START_LAG_MS = 10 * 60_000

/** An open stream with no sample (or start) newer than this isn't live now: nothing is keeping it up to date */
export const LIVE_STALE_MS = 15 * 60_000

/** A sample's time: the minute it fell in, so a second check in the same minute doesn't add another */
export const sampleMinute = (at: Date) => new Date(Math.floor(at.getTime() / 60_000) * 60_000)

/** Records a stream that went live. Returns whether the row is new; a row that exists is left as it is (a resend, or the other signal got there first) */
export async function recordStreamOnline(stream: { id: string; startedAt: Date; title?: string; gameName?: string | null }): Promise<{ created: boolean }> {
  const { count } = await prisma.twitchStream.createMany({
    data: [{ id: stream.id, startedAt: stream.startedAt, title: stream.title ?? "", gameName: stream.gameName ?? null }],
    skipDuplicates: true,
  })
  // A new stream means any other open one is over (a reconnect gets a new id)
  if (count) await closeStreams({ endedAt: stream.startedAt, startedBefore: stream.startedAt, exceptId: stream.id })
  return { created: count > 0 }
}

/** Opens a stream the live check closed again (Get Streams lists it after all). Returns whether it was closed */
export async function reopenStream(id: string): Promise<boolean> {
  const { count } = await prisma.twitchStream.updateMany({ where: { id, endedAt: { not: null } }, data: { endedAt: null } })
  return count > 0
}

/** Fills in or updates a stream's title and category (the title can change mid-stream). Never touches a closed stream's */
export async function updateStreamDetails(id: string, details: { title: string; gameName: string | null }): Promise<void> {
  if (!details.title) return
  await prisma.twitchStream.updateMany({ where: { id, endedAt: null }, data: { title: details.title, gameName: details.gameName } })
}

/** One viewer count for an open stream: the minute's sample (once), the peak, and the running average */
export async function recordViewerSample(streamId: string, at: Date, viewers: number): Promise<void> {
  await prisma.twitchViewerSample.createMany({ data: [{ streamId, at: sampleMinute(at), viewers }], skipDuplicates: true })
  const stats = await prisma.twitchViewerSample.aggregate({ where: { streamId }, _avg: { viewers: true }, _max: { viewers: true } })
  await prisma.twitchStream.updateMany({
    where: { id: streamId, endedAt: null },
    data: { peakViewers: stats._max.viewers ?? viewers, avgViewers: stats._avg.viewers ?? null },
  })
}

/**
 * Closes open streams: every one that started before `startedBefore`, or only `id` (or `ids`). Their
 * peak and average come from their samples. Returns how many it closed
 */
export async function closeStreams({ endedAt, startedBefore, id, ids, exceptId }: { endedAt: Date; startedBefore?: Date; id?: string; ids?: string[]; exceptId?: string }): Promise<number> {
  const open = await prisma.twitchStream.findMany({
    where: { endedAt: null, ...(id ? { id } : ids ? { id: { in: ids } } : {}), ...(startedBefore ? { startedAt: { lte: startedBefore } } : {}), ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true, startedAt: true },
  })
  let closed = 0
  for (const stream of open) {
    const stats = await prisma.twitchViewerSample.aggregate({ where: { streamId: stream.id }, _avg: { viewers: true }, _max: { viewers: true } })
    const end = endedAt < stream.startedAt ? stream.startedAt : endedAt
    const { count } = await prisma.twitchStream.updateMany({
      where: { id: stream.id, endedAt: null },
      data: { endedAt: end, avgViewers: stats._avg.viewers ?? null, ...(stats._max.viewers !== null ? { peakViewers: stats._max.viewers } : {}) },
    })
    closed += count
  }
  return closed
}

/**
 * Keeps each past broadcast's VOD and its view count (Twitch deletes VODs after a while). A broadcast
 * with no row yet (before the connector was on, or a stream both signals missed) gets one, closed, with
 * no viewer numbers, unless it may still be live: Get Streams lists it (`liveStreamId`), or its VOD
 * reaches into the last START_LAG_MS (a live broadcast's archive grows as it goes, and Get Streams can
 * lag). The live check opens those; a later snapshot adds what it didn't. Returns how many rows it
 * updated and added, and how many it left for later
 */
export async function recordVideos(videos: TwitchVideo[], at: Date, { liveStreamId }: { liveStreamId?: string | null } = {}): Promise<{ updated: number; added: number; deferred: number }> {
  let updated = 0
  let added = 0
  let deferred = 0
  for (const video of videos) {
    if (!video.streamId) continue
    const { count } = await prisma.twitchStream.updateMany({ where: { id: video.streamId }, data: { vodId: video.id, vodViews: video.views, vodViewsAt: at } })
    if (count) {
      updated += count
      continue
    }
    const endedAt = new Date(video.createdAt.getTime() + video.seconds * 1000)
    if (video.streamId === liveStreamId || endedAt.getTime() > at.getTime() - START_LAG_MS) {
      deferred++
      continue
    }
    const created = await prisma.twitchStream.createMany({
      data: [{ id: video.streamId, startedAt: video.createdAt, endedAt, title: video.title, vodId: video.id, vodViews: video.views, vodViewsAt: at }],
      skipDuplicates: true,
    })
    added += created.count
  }
  return { updated, added, deferred }
}

// ---------------------------------------------------------------------------
// Reads for other tracks (T8's twitch_live rule) and the pages
// ---------------------------------------------------------------------------

export type TwitchStreamRow = {
  id: string
  startedAt: Date
  endedAt: Date | null
  /** "" for a few seconds after going live, until the channel's title is read */
  title: string
  gameName: string | null
  peakViewers: number
  avgViewers: number | null
  vodId: string | null
  vodViews: number | null
}

const streamSelect = { id: true, startedAt: true, endedAt: true, title: true, gameName: true, peakViewers: true, avgViewers: true, vodId: true, vodViews: true } as const

/** The last time an open stream was seen live: its newest sample, or its start before the first */
export async function streamLastSeen(stream: { id: string; startedAt: Date }): Promise<Date> {
  const sample = await prisma.twitchViewerSample.findFirst({ where: { streamId: stream.id }, orderBy: { at: "desc" }, select: { at: true } })
  return sample?.at ?? stream.startedAt
}

/** Whether an open stream last seen at `lastSeen` still counts as live at `now` */
export const seenLately = (lastSeen: Date, now: Date) => now.getTime() - lastSeen.getTime() < LIVE_STALE_MS

/** The stream that's live now (the newest open row, if it was seen in the last LIVE_STALE_MS), or null */
export async function currentLiveStream(now = new Date()): Promise<TwitchStreamRow | null> {
  const open = await prisma.twitchStream.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" }, select: streamSelect })
  if (!open) return null
  return seenLately(await streamLastSeen(open), now) ? open : null
}

/** The newest stream that went live, open or ended, or null */
export async function latestStreamWentLive(): Promise<TwitchStreamRow | null> {
  return prisma.twitchStream.findFirst({ orderBy: { startedAt: "desc" }, select: streamSelect })
}

/**
 * Streams that went live after `since`, oldest first, at most `limit`: what a standing rule acts on
 * (it keeps its own cutoff, and dedupes on the stream id). Rows the daily snapshot added from old VODs
 * are ended already; a rule that only wants live streams checks endedAt
 */
export async function streamsWentLiveSince(since: Date, limit = 5): Promise<TwitchStreamRow[]> {
  return prisma.twitchStream.findMany({ where: { startedAt: { gt: since } }, orderBy: { startedAt: "asc" }, take: limit, select: streamSelect })
}
