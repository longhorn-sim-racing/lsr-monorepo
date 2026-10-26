import type { Metadata } from "next"
import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { Badge, Button, CellStack, DetailList, EmptyState, Notice, PageHeader, Panel, PanelBody, PanelHeader, Stat, StatRow, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { ChartView } from "@/components/jack/parts/chart-view"
import { PartLink } from "@/components/jack/parts/part-link"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { requireOfficerPage } from "@/server/auth/guards"
import { twitchConnector } from "@/server/connectors/twitch/connector"
import { TWITCH_CONNECT_PATH, TWITCH_CONNECT_RESULTS, type TwitchConnectResult } from "@/server/connectors/twitch/oauth"
import { twitchAccount } from "@/server/connectors/twitch/tokens"
import { followerSeries, listStreams, streamViewers, twitchOverview, type StreamSummary } from "@/server/queries/twitch"
import { DisconnectTwitchButton } from "./disconnect-button"
import { ago, centralDateTime, connectionBadge, dailyDate, formatCount, signed, streamLength } from "./format"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Streams" }

const DAY = 86_400_000
const RECENT_STREAMS = 25

/**
 * Content → Streams (#188, design §13): the club's Twitch channel from what the Twitch connector
 * stores. Officers see everything; admins connect or disconnect the club account. Nothing here calls
 * Twitch.
 */
export default async function AdminStreamsPage({ searchParams }: { searchParams: Promise<{ twitch?: string }> }) {
  await requireOfficerPage()
  const now = new Date()
  const [{ twitch: resultCode }, session, overview, streams, followers, status, account] = await Promise.all([
    searchParams,
    getCachedSessionUser(),
    twitchOverview(now),
    listStreams({ limit: RECENT_STREAMS, now }),
    followerSeries({ from: new Date(now.getTime() - 90 * DAY) }),
    twitchConnector.status(),
    twitchAccount(),
  ])
  const viewers = overview.live?.sampled ? await streamViewers(overview.live.id, 120) : []
  const isAdmin = session.roles.includes("admin")
  const result = resultCode && Object.hasOwn(TWITCH_CONNECT_RESULTS, resultCode) ? TWITCH_CONNECT_RESULTS[resultCode as TwitchConnectResult] : null
  const badge = connectionBadge(status.state)
  const { live, lastStream, last30 } = overview

  return (
    <>
      <PageHeader
        title="Streams"
        description="The club's Twitch channel: live status, past streams, VOD views and followers."
        actions={
          <Button size="sm" variant="ghost" asChild>
            <Link href="/admin/connections">Connections</Link>
          </Button>
        }
      />

      {result && (
        <Notice tone={result.tone} className="mb-4">
          {result.text}
        </Notice>
      )}
      {account.reconnect && (
        <Notice tone="danger" title="The club's Twitch account needs connecting again" className="mb-4">
          Twitch stopped accepting its token, so the follower count isn&apos;t updating. {isAdmin ? "Press Reconnect below and sign in to Twitch as the club account." : "An admin reconnects it here."}
        </Notice>
      )}
      {account.webhooksRevoked.length > 0 && (
        <Notice tone="warning" title="Twitch stopped sending live and offline notifications" className="mb-4">
          Twitch revoked {account.webhooksRevoked.map((r) => `${r.type} (${r.status}, ${centralDateTime(new Date(r.at))})`).join(" and ")}. Going live is still noticed by the every-minute check, a minute or two later. To fix it, run{" "}
          <code className="font-mono text-xs">pnpm --filter @lsr/platform exec tsx scripts/twitch-eventsub.ts --apply</code> with the production Twitch env vars (docs/jack-2/tracks/sources-b.md); this notice goes away when Twitch confirms the new subscription.
        </Notice>
      )}

      <StatRow>
        <Stat label="Live now" value={live ? <Badge tone="success">Live · {formatCount(live.viewersNow)} watching</Badge> : "Offline"} hint={live ? `Since ${formatInTimeZone(live.startedAt, DEFAULT_TIMEZONE, "h:mm a")}` : lastStream ? `Last streamed ${centralDateTime(lastStream.startedAt)}` : "No streams saved yet"} />
        <Stat label="Followers" value={formatCount(overview.followers.latest?.followers)} hint={overview.followers.change30 !== null ? `${signed(overview.followers.change30)} in 30 days` : overview.followers.latest ? `As of ${dailyDate(overview.followers.latest.date)}` : undefined} />
        <Stat label="Streams, last 30 days" value={last30.streams} hint={`${last30.hours} hours`} />
        <Stat label="Average viewers, last 30 days" value={last30.avgViewers ?? "—"} hint={last30.peakViewers !== null ? `Peak ${last30.peakViewers}` : "Counted while live"} />
      </StatRow>

      {live && (
        <Panel className="mb-4">
          <PanelHeader title={live.title || "Live now"} description={[live.gameName, `Started ${centralDateTime(live.startedAt)}`, `${streamLength(live.minutes)} so far`, live.peakViewers !== null ? `peak ${live.peakViewers}` : null].filter(Boolean).join(" · ")} actions={<Badge tone="success">Live</Badge>} />
          <PanelBody>
            {viewers.length > 1 ? (
              <ChartView chart={{ type: "line", title: "Viewers", xKey: "time", series: [{ key: "viewers", label: "Viewers" }], rows: viewers.map((v) => ({ time: formatInTimeZone(v.at, DEFAULT_TIMEZONE, "h:mm a"), viewers: v.viewers })) }} />
            ) : (
              <p className="text-[13px] text-muted-foreground">Viewers are counted once a minute while live; the chart starts after the second count.</p>
            )}
          </PanelBody>
        </Panel>
      )}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <StreamsPanel streams={streams} />
          <Panel>
            <PanelHeader title="Followers" description="One count a day, the last 90 days" />
            <PanelBody>
              {followers.length > 1 ? (
                <ChartView chart={{ type: "line", title: "Twitch followers", xKey: "date", series: [{ key: "followers", label: "Followers" }], rows: followers.map((p) => ({ date: dailyDate(p.date), followers: p.followers })) }} />
              ) : (
                <EmptyState title="No follower history yet" description="The daily snapshot saves the follower count once the club account is connected and the Twitch jobs are on." className="py-6" />
              )}
            </PanelBody>
          </Panel>
        </div>

        <Panel>
          <PanelHeader title="Twitch connection" actions={<Badge tone={badge.tone}>{badge.label}</Badge>} />
          <PanelBody className="flex flex-col gap-3">
            <DetailList
              items={[
                {
                  label: "Club account",
                  value: account.reconnect ? "Needs connecting again" : account.connected ? `@${account.login}${account.validatedAt ? `, checked ${ago(account.validatedAt)}` : ""}` : "Not connected",
                },
                { label: "Last sync", value: ago(status.lastSyncAt) ?? "Never" },
                ...(status.missingEnv.length ? [{ label: "Missing", value: <span className="font-mono text-xs">{status.missingEnv.join(", ")}</span> }] : []),
                ...(status.state === "error" && status.lastError ? [{ label: "Last error", value: <span className="text-tone-danger-foreground">{status.lastError}</span> }] : []),
              ]}
            />
            {isAdmin ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant={account.connected && !account.reconnect ? "secondary" : "primary"} asChild>
                  {/* A plain link: the route redirects to Twitch's consent page */}
                  <a href={TWITCH_CONNECT_PATH}>{account.connected ? "Reconnect the club account" : "Connect the club account"}</a>
                </Button>
                {account.connected && <DisconnectTwitchButton />}
              </div>
            ) : (
              !account.connected && <p className="text-xs text-admin-subtle">An admin connects the club&apos;s Twitch account here.</p>
            )}
            <p className="text-xs text-admin-subtle">
              Sign in to Twitch as the club account when connecting: it grants only the follower count. Live status and VODs need no grant. The Twitch jobs run from{" "}
              <Link href="/admin/jobs" className="underline underline-offset-2 hover:text-foreground">
                Scheduled jobs
              </Link>
              .
            </p>
          </PanelBody>
        </Panel>
      </div>
    </>
  )
}

function StreamsPanel({ streams }: { streams: StreamSummary[] }) {
  return (
    <Panel>
      <PanelHeader title="Recent streams" description="Viewers are concurrent viewers counted once a minute while live. Past broadcasts found only through their VODs have no viewer counts." />
      {streams.length === 0 ? (
        <EmptyState title="No streams saved yet" description="Streams show up here once the Twitch connection is on: when the club goes live, and from past broadcasts' VODs." />
      ) : (
        <Table minWidth={720} className="rounded-none border-0">
          <THead>
            <TH>Started</TH>
            <TH>Stream</TH>
            <TH className="text-right">Length</TH>
            <TH className="text-right">Peak</TH>
            <TH className="text-right">Average</TH>
            <TH className="text-right">VOD views</TH>
          </THead>
          <tbody>
            {streams.map((stream) => (
              <TR key={stream.id}>
                <TD className="whitespace-nowrap">{centralDateTime(stream.startedAt)}</TD>
                <TD className="max-w-[320px]">
                  <CellStack primary={stream.title || "Title not read yet"} secondary={stream.gameName ?? undefined} />
                </TD>
                <TD className="whitespace-nowrap text-right" title={!stream.endedAt && !stream.live ? "Not seen live lately, and its end wasn't recorded: the Twitch jobs close it when they run again" : undefined}>
                  {stream.live ? <Badge tone="success">Live</Badge> : streamLength(stream.minutes)}
                </TD>
                <TD className="text-right">{stream.sampled ? formatCount(stream.peakViewers) : <span className="text-admin-subtle" title="Viewers weren't counted for this stream">—</span>}</TD>
                <TD className="text-right">{stream.sampled ? formatCount(stream.avgViewers) : <span className="text-admin-subtle">—</span>}</TD>
                <TD className="whitespace-nowrap text-right">{stream.vodUrl ? <PartLink url={stream.vodUrl}>{formatCount(stream.vodViews)}</PartLink> : <span className="text-admin-subtle">—</span>}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  )
}
