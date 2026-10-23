import { Badge } from "@/components/admin/kit"
import { twitchConnector } from "@/server/connectors/twitch/connector"
import { listStreams, twitchOverview } from "@/server/queries/twitch"
import { centralDateTime, formatCount, signed, streamLength } from "../../streams/format"
import { OverviewPanel, type OverviewItem } from "../overview-list"
import type { OverviewCard } from "./types"

/** Streams: live now, or the last few streams (design §13). Nothing until Twitch is set up or a stream is saved */
async function StreamsCard() {
  const now = new Date()
  const [overview, recent, status] = await Promise.all([twitchOverview(now), listStreams({ limit: 3, now }), twitchConnector.status()])
  if (!recent.length && !overview.followers.latest && status.state === "not_configured") return null

  const items: OverviewItem[] = recent.map((stream) => ({
    key: stream.id,
    href: "/admin/streams",
    primary: stream.title || "Title not read yet",
    secondary: [centralDateTime(stream.startedAt), stream.live ? null : streamLength(stream.minutes)].filter(Boolean).join(" · "),
    meta: stream.live ? (
      <Badge tone="success">Live · {formatCount(overview.live?.id === stream.id ? overview.live.viewersNow : null)} watching</Badge>
    ) : stream.sampled ? (
      <span>
        Peak {formatCount(stream.peakViewers)} · avg {formatCount(stream.avgViewers)}
      </span>
    ) : (
      <span>{stream.vodViews !== null ? `${formatCount(stream.vodViews)} VOD views` : "Viewers not counted"}</span>
    ),
  }))
  const followers = overview.followers.latest
  const description = [overview.live ? "Live now" : "Offline", followers ? `${formatCount(followers.followers)} followers${overview.followers.change30 !== null ? ` (${signed(overview.followers.change30)} in 30 days)` : ""}` : null].filter(Boolean).join(" · ")

  return <OverviewPanel title="Streams" description={description} viewAll={{ href: "/admin/streams", label: "Streams" }} items={items} empty={status.state === "connected" ? "No streams saved yet." : "Twitch isn't connected yet; see System → Connections."} />
}

/** Overview cards from the sources-b track. The registry joins every track's cards and sorts them by order */
export const CARDS: OverviewCard[] = [{ id: "streams", order: 40, Card: StreamsCard }]
