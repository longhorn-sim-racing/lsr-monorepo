import type { Metadata } from "next"
import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { requireOfficerPage } from "@/server/auth/guards"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { discordConnector } from "@/server/connectors/discord/connector"
import { CHANNEL_KIND, discordActivity, discordChannels, discordPolls, type DiscordPollView } from "@/server/queries/discord"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { Badge, Button, EmptyState, Notice, PageHeader, Panel, PanelBody, PanelHeader, Stat, StatRow, Table, TD, TH, THead, TR, type Tone } from "@/components/admin/kit"
import { ChartView } from "@/components/jack/parts/chart-view"
import { when } from "../connections/view"
import { DiscordSections } from "./_sections"
import { ChannelList } from "./channel-list"
import { PurgeForm } from "./purge-form"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Discord" }

const ACTIVITY_DAYS = 30
const POLL_DAYS = 90

const STATE: Record<string, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "success" },
  off: { label: "Off", tone: "neutral" },
  not_configured: { label: "Not set up", tone: "warning" },
  error: { label: "Failing", tone: "danger" },
}

const day = (date: Date, pattern = "MMM d") => formatInTimeZone(date, "UTC", pattern)
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`

/** One poll's answers as bars, with counts in text (the bar only repeats the number) */
function PollItem({ view }: { view: DiscordPollView }) {
  const total = view.totalVotes ?? 0
  const top = Math.max(1, ...view.poll.answers.map((a) => a.votes ?? 0))
  const status = view.status === "open" ? { label: "Open", tone: "info" as Tone } : view.status === "final" ? { label: "Final", tone: "neutral" as Tone } : { label: "Closing", tone: "warning" as Tone }
  return (
    <li className="flex flex-col gap-2 border-b border-admin-row px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold">{view.poll.question || "(no question)"}</span>
          <span className="text-xs text-admin-subtle">
            {view.channel} · {formatInTimeZone(view.postedAt, DEFAULT_TIMEZONE, "MMM d")} · {view.totalVotes === null ? "no counts yet" : plural(total, "vote")}
            {view.poll.multiselect && " · multiple choice"}
          </span>
        </span>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <ul className="flex flex-col gap-1.5">
        {view.poll.answers.map((answer) => (
          <li key={answer.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs">
            <span className="truncate">{answer.text}</span>
            <span className="tabular-nums text-muted-foreground">
              {answer.votes === null ? "–" : `${answer.votes}${total ? ` · ${Math.round((answer.votes / total) * 100)}%` : ""}`}
            </span>
            <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-admin-surface" aria-hidden>
              <span className="block h-full rounded-full" style={{ width: `${((answer.votes ?? 0) / top) * 100}%`, background: "var(--series-1)" }} />
            </span>
          </li>
        ))}
      </ul>
    </li>
  )
}

export default async function AdminDiscordPage() {
  await requireOfficerPage()
  const now = new Date()
  const [status, session, channels, activity, { polls, matched }] = await Promise.all([
    discordConnector.status(),
    getCachedSessionUser(),
    discordChannels(now),
    discordActivity({ days: ACTIVITY_DAYS, now }),
    discordPolls({ days: POLL_DAYS, limit: 8, now }),
  ])
  const isAdmin = session.roles.includes("admin")
  const state = STATE[status.state]
  const lastSync = when(status.lastSyncAt, now)
  const synced = channels.filter((c) => c.synced).length
  const latest = activity.members.at(-1)
  const joined = activity.members.reduce((n, m) => n + (m.joined ?? 0), 0)
  const left = activity.members.reduce((n, m) => n + (m.left ?? 0), 0)
  const hasData = activity.messages > 0 || activity.members.length > 0

  return (
    <>
      <PageHeader
        title="Discord"
        description={[state.label, lastSync ? `last sync ${lastSync.ago}` : "never synced", `${synced} of ${plural(channels.length, "channel")} synced`].join(" · ")}
        actions={
          <Button asChild>
            <Link href="/admin/connections">Connections</Link>
          </Button>
        }
      />

      {status.state === "not_configured" || status.state === "off" ? (
        <Notice tone={status.state === "off" ? "neutral" : "warning"} title="Discord isn't connected" className="mb-4">
          {status.state === "off" ? "It's set up but switched off" : `It isn't set up yet (missing ${[...status.missingEnv, ...status.missingSettings].join(", ")})`}. An admin switches it on from{" "}
          <Link href="/admin/connections" className="font-medium text-foreground underline-offset-2 hover:underline">
            Connections
          </Link>{" "}
          after its smoke test. Until then nothing syncs, and Jack can&apos;t search Discord.
          {hasData ? " What's below is what was synced before." : ""}
        </Notice>
      ) : status.state === "error" && status.lastError ? (
        <Notice tone="danger" title="The last Discord sync failed" className="mb-4">
          {status.lastError}
        </Notice>
      ) : null}

      <StatRow>
        <Stat label="Messages" value={activity.messages.toLocaleString("en-US")} hint={`Last ${ACTIVITY_DAYS} days, synced channels`} />
        <Stat label="Active members" value={activity.activeMembers.toLocaleString("en-US")} hint={`Posted in the last ${ACTIVITY_DAYS} days`} />
        <Stat label="Members" value={latest ? latest.memberCount.toLocaleString("en-US") : "–"} hint={latest ? `${joined} joined, ${left} left in ${ACTIVITY_DAYS} days` : "Counted from the first member sync"} />
        <Stat label="Linked accounts" value={activity.linkedMembers.toLocaleString("en-US")} hint="Members who linked Discord on their profile" />
      </StatRow>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader title="Activity" description={`Messages per day in the synced channels (threads count toward their channel), last ${ACTIVITY_DAYS} days`} />
            <PanelBody className="flex flex-col gap-4">
              {activity.messages ? (
                <ChartView
                  chart={{
                    type: "bar",
                    title: "Messages per day",
                    xKey: "day",
                    series: [{ key: "messages", label: "Messages" }],
                    rows: activity.daily.map((d) => ({ day: day(d.date), messages: d.messages })),
                  }}
                />
              ) : (
                <EmptyState title="No activity yet" description={synced ? "Messages appear after the next sync." : "Opt a channel in to start counting its messages."} />
              )}
              {activity.channels.length > 0 && (
                <Table minWidth={440}>
                  <THead>
                    <TH>Channel</TH>
                    <TH className="text-right">Messages</TH>
                    <TH className="text-right">Active members</TH>
                    <TH>Busiest day</TH>
                  </THead>
                  <tbody>
                    {activity.channels.map((c) => (
                      <TR key={c.id}>
                        <TD className="font-semibold">#{c.name}</TD>
                        <TD className="text-right">{c.messages.toLocaleString("en-US")}</TD>
                        <TD className="text-right">{c.activeMembers.toLocaleString("en-US")}</TD>
                        <TD className="text-muted-foreground">{c.busiestDay ? `${day(c.busiestDay, "EEE, MMM d")} (${c.busiestDayMessages})` : "–"}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              )}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Members over time" description="People in the server each day (bots not counted), from the hourly member sync" />
            <PanelBody>
              {activity.members.length > 1 ? (
                <ChartView
                  chart={{
                    type: "line",
                    title: "Members",
                    xKey: "day",
                    series: [{ key: "members", label: "Members" }],
                    rows: activity.members.map((m) => ({ day: day(m.date), members: m.memberCount })),
                  }}
                />
              ) : (
                <EmptyState
                  title={latest ? `${plural(latest.memberCount, "member")} so far` : "No member counts yet"}
                  description="The line starts once the member sync has run on two different days. Discord keeps no history, so it can't be filled in backwards."
                />
              )}
            </PanelBody>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader
              title="Channels"
              description={isAdmin ? "Pick which channels sync. Only metadata is kept (who posted when, never what they wrote), and Jack searches synced channels live." : "Which channels sync. Admins change this."}
            />
            <ChannelList
              isAdmin={isAdmin}
              channels={channels.map((c) => ({ id: c.id, name: c.name, kind: CHANNEL_KIND[c.type] ?? "Channel", category: c.category, synced: c.synced, threads: c.threads, messages30: c.messages30, lastSync: when(c.lastSyncedAt, now)?.ago ?? null }))}
            />
          </Panel>

          <Panel>
            <PanelHeader title="Polls" description={`Results in the synced channels, last ${POLL_DAYS} days${matched > polls.length ? ` (newest ${polls.length} of ${matched})` : ""}. Totals only: who voted is never read.`} />
            {polls.length ? (
              <ul>
                {polls.map((view) => (
                  <PollItem key={view.id} view={view} />
                ))}
              </ul>
            ) : (
              <EmptyState title="No polls" description={`No polls in the synced channels in the last ${POLL_DAYS} days.`} />
            )}
          </Panel>
        </div>
      </div>

      <DiscordSections />

      {isAdmin && (
        <Panel className="mt-4">
          <PanelHeader title="Deletion requests" description="When someone asks the club to delete their Discord data. Admins only; recorded in the audit log." />
          <PanelBody>
            <PurgeForm />
          </PanelBody>
        </Panel>
      )}

      <p className="mt-4 text-xs text-admin-subtle">
        Counts only, never per person: Discord&apos;s developer policy bans profiling members. Message text is never stored; message records are deleted after 12 months. What members are told:{" "}
        <Link href="/privacy#discord" className="underline-offset-2 hover:text-foreground hover:underline">
          the privacy policy
        </Link>
        .
      </p>
    </>
  )
}
