import { prisma } from "@/server/db"

/**
 * Reads of the club's Twitch numbers (#188, design §12.2), from the tables the Twitch connector fills,
 * for Content → Streams, the Overview card and Jack's twitch_stats. Viewer numbers exist only for
 * streams sampled live: a past broadcast added from its VOD has none (`sampled: false`), which is not
 * the same as nobody watching.
 */

export type StreamSummary = {
  id: string
  title: string
  gameName: string | null
  startedAt: Date
  endedAt: Date | null
  /** Length in minutes; for a live stream, so far */
  minutes: number
  /** Whether viewers were sampled; without samples peak and average are null */
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
  _count: { samples: number }
}

const streamSelect = { id: true, title: true, gameName: true, startedAt: true, endedAt: true, peakViewers: true, avgViewers: true, vodId: true, vodViews: true, _count: { select: { samples: true } } } as const

export function toStreamSummary(row: StreamRow, now = new Date()): StreamSummary {
  const sampled = row._count.samples > 0
  return {
    id: row.id,
    title: row.title,
    gameName: row.gameName,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    minutes: Math.max(0, Math.round(((row.endedAt ?? now).getTime() - row.startedAt.getTime()) / 60_000)),
    sampled,
    peakViewers: sampled ? row.peakViewers : null,
    avgViewers: sampled && row.avgViewers !== null ? Math.round(row.avgViewers * 10) / 10 : null,
    vodId: row.vodId,
    vodViews: row.vodViews,
    vodUrl: row.vodId ? `https://www.twitch.tv/videos/${encodeURIComponent(row.vodId)}` : null,
  }
}

/** Streams that started in [from, to), newest first */
export async function listStreams({ from, to, limit = 50, now = new Date() }: { from?: Date; to?: Date; limit?: number; now?: Date } = {}): Promise<StreamSummary[]> {
  const rows = await prisma.twitchStream.findMany({
    where: { startedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: streamSelect,
  })
  return rows.map((row) => toStreamSummary(row, now))
}

/** One stream by id, or the newest one */
export async function findStream(id?: string, now = new Date()): Promise<StreamSummary | null> {
  const row = id ? await prisma.twitchStream.findUnique({ where: { id }, select: streamSelect }) : await prisma.twitchStream.findFirst({ orderBy: { startedAt: "desc" }, select: streamSelect })
  return row ? toStreamSummary(row, now) : null
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
  const [liveRow, lastRow, recent, followers] = await Promise.all([
    prisma.twitchStream.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" }, select: streamSelect }),
    prisma.twitchStream.findFirst({ where: { endedAt: { not: null } }, orderBy: { startedAt: "desc" }, select: streamSelect }),
    listStreams({ from: new Date(now.getTime() - 30 * DAY), limit: 500, now }),
    followerSeries({ from: new Date(now.getTime() - 400 * DAY) }),
  ])
  let live: TwitchOverview["live"] = null
  if (liveRow) {
    const sample = await prisma.twitchViewerSample.findFirst({ where: { streamId: liveRow.id }, orderBy: { at: "desc" }, select: { at: true, viewers: true } })
    live = { ...toStreamSummary(liveRow, now), viewersNow: sample?.viewers ?? null, lastSampleAt: sample?.at ?? null }
  }
  const sampled = recent.filter((s) => s.sampled)
  const points = followers.map((p) => ({ date: p.date, value: p.followers }))
  return {
    live,
    lastStream: lastRow ? toStreamSummary(lastRow, now) : null,
    last30: {
      streams: recent.length,
      hours: Math.round((recent.reduce((sum, s) => sum + s.minutes, 0) / 60) * 10) / 10,
      peakViewers: sampled.length ? Math.max(...sampled.map((s) => s.peakViewers ?? 0)) : null,
      avgViewers: sampled.length ? Math.round((sampled.reduce((sum, s) => sum + (s.avgViewers ?? 0), 0) / sampled.length) * 10) / 10 : null,
    },
    followers: { latest: followers[followers.length - 1] ?? null, change7: changeOver(points, 7), change30: changeOver(points, 30) },
  }
}
