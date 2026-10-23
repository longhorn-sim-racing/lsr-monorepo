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
 * - **Closes** (endedAt) on stream.offline, or after 3 live checks in a row that don't see it (one empty
 *   Get Streams result isn't trusted). A closed row is never reopened: a reconnect after an encoder
 *   drop is a new stream with a new id, and the old one is closed when the new one opens.
 * - **VOD**: the daily snapshot sets vodId and vodViews, and adds rows for past broadcasts it finds
 *   without one (peakViewers 0 and avgViewers null there: viewers weren't sampled).
 */

/** Live checks in a row that must miss an open stream before it's closed */
export const EMPTY_CHECKS_TO_CLOSE = 3

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
 * Closes open streams: every one that started before `startedBefore`, or only `id`. Their peak and
 * average come from their samples. Returns how many it closed
 */
export async function closeStreams({ endedAt, startedBefore, id, exceptId }: { endedAt: Date; startedBefore?: Date; id?: string; exceptId?: string }): Promise<number> {
  const open = await prisma.twitchStream.findMany({
    where: { endedAt: null, ...(id ? { id } : {}), ...(startedBefore ? { startedAt: { lte: startedBefore } } : {}), ...(exceptId ? { NOT: { id: exceptId } } : {}) },
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
 * no viewer numbers. Returns how many rows it updated and added
 */
export async function recordVideos(videos: TwitchVideo[], at: Date): Promise<{ updated: number; added: number }> {
  let updated = 0
  let added = 0
  for (const video of videos) {
    if (!video.streamId) continue
    const { count } = await prisma.twitchStream.updateMany({ where: { id: video.streamId }, data: { vodId: video.id, vodViews: video.views, vodViewsAt: at } })
    if (count) {
      updated += count
      continue
    }
    const created = await prisma.twitchStream.createMany({
      data: [
        {
          id: video.streamId,
          startedAt: video.createdAt,
          endedAt: new Date(video.createdAt.getTime() + video.seconds * 1000),
          title: video.title,
          vodId: video.id,
          vodViews: video.views,
          vodViewsAt: at,
        },
      ],
      skipDuplicates: true,
    })
    added += created.count
  }
  return { updated, added }
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

/** The stream that's live now (the newest open row), or null */
export async function currentLiveStream(): Promise<TwitchStreamRow | null> {
  return prisma.twitchStream.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" }, select: streamSelect })
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
