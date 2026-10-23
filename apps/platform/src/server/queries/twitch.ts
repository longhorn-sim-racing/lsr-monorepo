import { prisma } from "@/server/db"
import { seenLately, streamLastSeen } from "@/server/connectors/twitch/streams"

/**
 * Reads of the club's Twitch numbers (#188, design §12.2), from the tables the Twitch connector fills,
 * for Content → Streams, the Overview card and Jack's twitch_stats. Viewer numbers exist only for
 * streams sampled live: a past broadcast added from its VOD has none (`sampled: false`), which is not
 * the same as nobody watching. A stream's peak and average stay after its samples are pruned (180 days).
 * An open stream is `live` only while something keeps it up to date (see connectors/twitch/streams.ts).
 */

export type StreamSummary = {
  id: string
  title: string
  gameName: string | null
  startedAt: Date
  endedAt: Date | null
  /** Open and seen in the last 15 minutes. An open stream that isn't (the Twitch jobs stopped) has no end yet, but isn't live */
  live: boolean
  /** For an open stream: its last viewer count, or its start before the first */
  lastSeenAt: Date | null
  /** Length in minutes; for a live stream, so far; for an open one that isn't live, to when it was last seen */
  minutes: number
  /** Whether viewers were counted while live; without that peak and average are null */
  sampled: boolean
  peakViewers: number | null
  avgViewers: number | null
  vodId: string | null
  vodViews: number | null
  vodUrl: string | null
}

export type FollowerPoint = { date: Date; followers: number }

const DAY = 86_400_000

type StreamRow = {
  id: string
  title: string
  gameName: string | null
  startedAt: Date
  endedAt: Date | null
  peakViewers: number
  avgViewers: number | null
  vodId: string | null
  vodViews: number | null
}

const streamSelect = { id: true, title: true, gameName: true, startedAt: true, endedAt: true, peakViewers: true, avgViewers: true, vodId: true, vodViews: true } as const

/** `lastSeenAt` is needed for an open stream (streamLastSeen); without it, it counts from the start */
export function toStreamSummary(row: StreamRow, now = new Date(), lastSeenAt?: Date): StreamSummary {
  // avgViewers is set from the first sample on and kept when samples are pruned; VOD-only rows have none
  const sampled = row.avgViewers !== null
  const seen = row.endedAt ? null : (lastSeenAt ?? row.startedAt)
  const live = seen !== null && seenLately(seen, now)
  const end = row.endedAt ?? (live ? now : (seen ?? now))
  return {
    id: row.id,
    title: row.title,
    gameName: row.gameName,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    live,
    lastSeenAt: seen,
    minutes: Math.max(0, Math.round((end.getTime() - row.startedAt.getTime()) / 60_000)),
    sampled,
    peakViewers: sampled ? row.peakViewers : null,
    avgViewers: row.avgViewers !== null ? Math.round(row.avgViewers * 10) / 10 : null,
    vodId: row.vodId,
    vodViews: row.vodViews,
    vodUrl: row.vodId ? `https://www.twitch.tv/videos/${encodeURIComponent(row.vodId)}` : null,
  }
}

/** Summaries, looking up when each open stream was last seen (usually there's one at most) */
async function summarize(rows: StreamRow[], now: Date): Promise<StreamSummary[]> {
  return Promise.all(rows.map(async (row) => toStreamSummary(row, now, row.endedAt ? undefined : await streamLastSeen(row))))
}

/** Streams that started in [from, to), newest first */
export async function listStreams({ from, to, limit = 50, now = new Date() }: { from?: Date; to?: Date; limit?: number; now?: Date } = {}): Promise<StreamSummary[]> {
  const rows = await prisma.twitchStream.findMany({
    where: { startedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: streamSelect,
  })
  return summarize(rows, now)
}

/** One stream by id, or the newest one */
export async function findStream(id?: string, now = new Date()): Promise<StreamSummary | null> {
  const row = id ? await prisma.twitchStream.findUnique({ where: { id }, select: streamSelect }) : await prisma.twitchStream.findFirst({ orderBy: { startedAt: "desc" }, select: streamSelect })
  return row ? ((await summarize([row], now))[0] ?? null) : null
}

/** A stream's viewer samples in order, thinned to at most `maxPoints` (each kept point is the peak of its stretch) */
export async function streamViewers(streamId: string, maxPoints = 60): Promise<{ at: Date; viewers: number }[]> {
  const samples = await prisma.twitchViewerSample.findMany({ where: { streamId }, orderBy: { at: "asc" }, select: { at: true, viewers: true } })
  if (samples.length <= maxPoints) return samples
  const size = Math.ceil(samples.length / maxPoints)
  const thinned: { at: Date; viewers: number }[] = []
  for (let i = 0; i < samples.length; i += size) {
    const stretch = samples.slice(i, i + size)
    thinned.push({ at: stretch[0].at, viewers: Math.max(...stretch.map((s) => s.viewers)) })
  }
  return thinned
}

/** The follower total per day (Central dates), oldest first */
export async function followerSeries({ from, to }: { from?: Date; to?: Date } = {}): Promise<FollowerPoint[]> {
  const rows = await prisma.twitchChannelDaily.findMany({
    where: { followers: { not: null }, date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
    orderBy: { date: "asc" },
    select: { date: true, followers: true },
  })
  return rows.map((row) => ({ date: row.date, followers: row.followers ?? 0 }))
}

/** How much a daily count changed over `days`: the latest value minus the newest one at least that old, or null without one */
export function changeOver(series: { date: Date; value: number }[], days: number): number | null {
  const latest = series[series.length - 1]
  if (!latest) return null
  const cutoff = latest.date.getTime() - days * DAY
  const before = [...series].reverse().find((point) => point.date.getTime() <= cutoff)
  return before ? latest.value - before.value : null
}

export type TwitchOverview = {
  live: (StreamSummary & { viewersNow: number | null; lastSampleAt: Date | null }) | null
  lastStream: StreamSummary | null
  last30: { streams: number; hours: number; peakViewers: number | null; avgViewers: number | null }
  followers: { latest: FollowerPoint | null; change7: number | null; change30: number | null }
}

/** What's live now, the last stream, the last 30 days and followers: Content → Streams, the Overview card and twitch_stats */
export async function twitchOverview(now = new Date()): Promise<TwitchOverview> {
  const [openRow, lastRow, recent, followers] = await Promise.all([
    prisma.twitchStream.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" }, select: streamSelect }),
    prisma.twitchStream.findFirst({ where: { endedAt: { not: null } }, orderBy: { startedAt: "desc" }, select: streamSelect }),
    listStreams({ from: new Date(now.getTime() - 30 * DAY), limit: 500, now }),
    followerSeries({ from: new Date(now.getTime() - 400 * DAY) }),
  ])
  let live: TwitchOverview["live"] = null
  let lastStream = lastRow ? toStreamSummary(lastRow, now) : null
  if (openRow) {
    const sample = await prisma.twitchViewerSample.findFirst({ where: { streamId: openRow.id }, orderBy: { at: "desc" }, select: { at: true, viewers: true } })
    const open = toStreamSummary(openRow, now, sample?.at ?? openRow.startedAt)
    if (open.live) live = { ...open, viewersNow: sample?.viewers ?? null, lastSampleAt: sample?.at ?? null }
    // Open but not seen lately (the Twitch jobs stopped mid-stream): not live now, so the last stream if it's the newest
    else if (!lastStream || open.startedAt > lastStream.startedAt) lastStream = open
  }
  const sampled = recent.filter((s) => s.sampled)
  const points = followers.map((p) => ({ date: p.date, value: p.followers }))
  return {
    live,
    lastStream,
    last30: {
      streams: recent.length,
      hours: Math.round((recent.reduce((sum, s) => sum + s.minutes, 0) / 60) * 10) / 10,
      peakViewers: sampled.length ? Math.max(...sampled.map((s) => s.peakViewers ?? 0)) : null,
      avgViewers: sampled.length ? Math.round((sampled.reduce((sum, s) => sum + (s.avgViewers ?? 0), 0) / sampled.length) * 10) / 10 : null,
    },
    followers: { latest: followers[followers.length - 1] ?? null, change7: changeOver(points, 7), change30: changeOver(points, 30) },
  }
}
