import { formatInTimeZone } from "date-fns-tz"
import { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"
import { twitchConnector } from "@/server/connectors/twitch/connector"
import { findStream, followerSeries, listStreams, streamViewers, twitchOverview, type StreamSummary } from "@/server/queries/twitch"
import { forModelWithLists, plural, tableDisplay } from "./display"
import { sourceConnection } from "./source-connection"
import { centralDateInput, centralRange, CLUB_TZ, ct, ctShort } from "./time"
import type { JackTool, JackToolResult } from "./types"

/**
 * twitch_stats (#188, design §7.1, sources-b): the club's Twitch channel from the tables the Twitch
 * connector keeps. Viewer counts are concurrent viewers sampled once a minute while live (not unique
 * viewers); past broadcasts added from their VODs have no viewer numbers.
 */

const VIEWS = ["overview", "streams", "stream", "followers"] as const

const input = z.object({
  view: z
    .enum(VIEWS)
    .default("overview")
    .describe("overview: live now, the last stream, the last 30 days and followers. streams: past streams in a date range with peak and average viewers and VOD views. stream: one stream minute by minute (the newest by default). followers: the follower total per day"),
  from: centralDateInput.optional().describe("First Central date, YYYY-MM-DD (streams and followers; default 30 days ago)"),
  to: centralDateInput.optional().describe("Last Central date (default today)"),
  streamId: z.string().trim().min(1).max(40).optional().describe("A stream's id from a streams result (view stream)"),
  limit: z.number().int().min(1).max(100).default(30).describe("Most streams to list"),
})

type Input = z.infer<typeof input>

const DATA_NOTES = [
  "Viewers are concurrent viewers counted once a minute while live (Twitch's cached count), not unique viewers.",
  "A stream with sampled: false had no viewers counted (usually one added from its VOD after the fact), which doesn't mean nobody watched.",
  "Minute-by-minute counts are kept for 180 days; a stream's peak and average stay after that.",
  "VOD views keep rising after a stream; vodViews is the count at the last daily snapshot.",
]

const hours = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`

/** When it ended: a time, "live now", or, for an open stream nothing has updated lately, when it was last seen */
const endedText = (s: StreamSummary) => (s.endedAt ? ct(s.endedAt) : s.live ? "live now" : `not live now; its end wasn't recorded (last seen live ${s.lastSeenAt ? ct(s.lastSeenAt) : "at its start"})`)

function streamForModel(s: StreamSummary) {
  return {
    id: s.id,
    started: ct(s.startedAt),
    ended: endedText(s),
    length: hours(s.minutes),
    title: s.title || "(title not read yet)",
    game: s.gameName,
    sampled: s.sampled,
    peakViewers: s.peakViewers,
    avgViewers: s.avgViewers,
    vodViews: s.vodViews,
    vodUrl: s.vodUrl,
  }
}

const streamsTable = (streams: StreamSummary[], caption?: string) =>
  tableDisplay(
    streams,
    [
      { header: "Started", value: (s) => ctShort(s.startedAt) },
      { header: "Title", value: (s) => s.title || "—" },
      { header: "Length", value: (s) => (s.live ? `${hours(s.minutes)} (live)` : hours(s.minutes)) },
      { header: "Peak", value: (s) => s.peakViewers ?? "—" },
      { header: "Average", value: (s) => s.avgViewers ?? "—" },
      { header: "VOD views", value: (s) => s.vodViews ?? "—" },
    ],
    caption,
  )

async function overview(now: Date): Promise<JackToolResult> {
  const [data, connection] = await Promise.all([twitchOverview(now), sourceConnection(twitchConnector, "Twitch")])
  const { live, lastStream, last30, followers } = data
  const displays: JackToolDisplay[] = [
    {
      kind: "stats",
      items: [
        live ? { label: "Live now", value: live.viewersNow ?? "—", hint: `viewers · since ${ctShort(live.startedAt)}` } : { label: "Live now", value: "No", hint: lastStream ? `last streamed ${ctShort(lastStream.startedAt)}` : undefined },
        { label: "Followers", value: followers.latest?.followers ?? "—", hint: followers.change30 !== null ? `${followers.change30 >= 0 ? "+" : ""}${followers.change30} in 30 days` : undefined },
        { label: "Streams (30 days)", value: last30.streams, hint: `${last30.hours} hours` },
        { label: "Average viewers (30 days)", value: last30.avgViewers ?? "—", hint: last30.peakViewers !== null ? `peak ${last30.peakViewers}` : undefined },
      ],
    },
  ]
  if (!connection.connected && !live && !lastStream && !followers.latest) displays.push({ kind: "note", text: connection.note ?? "Twitch isn't connected." })
  return {
    forModel: forModelWithLists(
      {
        connection: connection.note,
        live: live ? { ...streamForModel(live), viewersNow: live.viewersNow, lastCounted: live.lastSampleAt ? ct(live.lastSampleAt) : null } : null,
        lastStream: lastStream ? streamForModel(lastStream) : null,
        last30Days: last30,
        followers: { latest: followers.latest?.followers ?? null, asOf: followers.latest?.date.toISOString().slice(0, 10) ?? null, changeLast7Days: followers.change7, changeLast30Days: followers.change30 },
        dataNotes: DATA_NOTES,
      },
      [],
    ),
    label: live ? `Looked at Twitch (live now, ${plural(live.viewersNow ?? 0, "viewer")})` : "Looked at Twitch",
    displays,
  }
}

export const twitchStatsTool: JackTool<Input> = {
  name: "twitch_stats",
  description:
    "Twitch stats for the club's channel, from what the site stores: whether we're live now and with how many viewers, past streams (title, game, length, peak and average concurrent viewers, VOD views), one stream's viewers minute by minute, and the follower total over time. Says when Twitch isn't connected or how fresh the numbers are.",
  input,
  deferred: true,
  async run(args) {
    const now = new Date()
    if (args.view === "overview") return overview(now)
    const connection = await sourceConnection(twitchConnector, "Twitch")

    if (args.view === "stream") {
      const stream = await findStream(args.streamId, now)
      if (!stream) {
        return { isError: !!args.streamId, forModel: args.streamId ? `No stream with id ${args.streamId}. Use view streams to find one.` : JSON.stringify({ connection: connection.note, note: "No streams are stored yet." }), label: "Looked at a Twitch stream (none found)", displays: [] }
      }
      const viewers = stream.sampled ? await streamViewers(stream.id) : []
      // Counted, but no samples left: they were pruned after 180 days (the peak and average stay)
      const note = stream.sampled
        ? viewers.length
          ? null
          : "This stream's minute-by-minute counts were deleted after 180 days; its peak and average are kept."
        : stream.live
          ? "No viewer count yet: viewers are counted once a minute while live."
          : "This stream's viewers weren't counted (usually one added from its VOD)."
      const displays: JackToolDisplay[] = note
        ? [{ kind: "note", text: note }]
        : [{ kind: "chart", chart: { type: "line", title: `Viewers: ${stream.title || "stream"} (${ctShort(stream.startedAt)})`, xKey: "time", series: [{ key: "viewers", label: "Viewers" }], rows: viewers.map((v) => ({ time: formatInTimeZone(v.at, CLUB_TZ, "h:mm a"), viewers: v.viewers })), yLabel: "Viewers" } }]
      return {
        forModel: forModelWithLists({ connection: connection.note, stream: streamForModel(stream), ...(note ? { note } : {}), dataNotes: DATA_NOTES }, [{ key: "viewersByMinute", items: viewers.map((v) => ({ at: ct(v.at), viewers: v.viewers })), keep: "first" }]),
        label: `Looked at a Twitch stream (${ctShort(stream.startedAt)})`,
        displays,
      }
    }

    const range = centralRange(args, { fromDaysAgo: 30, toDaysAhead: 0 }, now)
    if (!range.ok) return { isError: true, forModel: range.error, label: "Twitch lookup failed", displays: [] }

    if (args.view === "followers") {
      const series = await followerSeries({ from: new Date(`${range.from}T00:00:00Z`), to: new Date(`${range.to}T00:00:00Z`) })
      const rows = series.map((p) => ({ date: p.date.toISOString().slice(0, 10), followers: p.followers }))
      return {
        forModel: forModelWithLists({ connection: connection.note, from: range.from, to: range.to, note: rows.length ? "One snapshot a day (Central dates); days without one are missing." : "No follower snapshots in this range." }, [{ key: "followersByDay", items: rows, keep: "last", whenTrimmed: "Ask for a shorter range." }]),
        label: `Looked at Twitch followers (${rows.length ? `${rows[rows.length - 1].followers} now` : "none stored"})`,
        displays: rows.length > 1 ? [{ kind: "chart", chart: { type: "line", title: "Twitch followers", xKey: "date", series: [{ key: "followers", label: "Followers" }], rows } }] : [],
      }
    }

    const streams = await listStreams({ from: range.start, to: new Date(range.end.getTime() + 1), limit: args.limit, now })
    return {
      forModel: forModelWithLists({ connection: connection.note, from: range.from, to: range.to, count: streams.length, dataNotes: DATA_NOTES }, [{ key: "streams", items: streams.map(streamForModel) }]),
      label: `Looked at Twitch streams (${plural(streams.length, "stream")})`,
      displays: streams.length ? [streamsTable(streams, `${range.from} to ${range.to}`)] : [{ kind: "note", text: connection.connected && !connection.failing ? "No streams in this range." : (connection.note ?? "No streams in this range.") }],
    }
  },
}
